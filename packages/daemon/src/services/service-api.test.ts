import { expect, test } from 'bun:test';
import type { Socket } from 'node:net';
import type { ImpContract, ServiceLog } from '@imp/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import * as z from 'zod';
import {
  FRAME_TYPES,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from '../agent-client/frame-codec';
import type { AgentService } from '../agent-client/service-requests';
import { subscribeImpWrites } from '../db/imp-write-feed';
import { updateImpActivity } from '../db/imps';
import { buildTestApp, setupImpTest } from '../imps/test-imps';
import { readRejection } from '../read-rejection';
import { buildImpPaths } from '../storage/data-layout';
import { startFakeAgent } from '../test-utils/start-stub-agent';

const IMAGE_USER = 'dev';
const LOG_INODE = 7;

const AgentDefSchema = z.object({
  name: z.string(),
  argv: z.array(z.string()).readonly(),
  env: z.array(z.string()).readonly().optional(),
  user: z.string().optional(),
  restart: z.enum(['always', 'on-failure', 'never']).optional(),
});

const AgentRequestSchema = z.object({
  op: z.string(),
  service: z.string().optional(),
  def: AgentDefSchema.optional(),
  replace: z.boolean().optional(),
  lines: z.int().optional(),
  follow: z.boolean().optional(),
  cursor: z.object({ inode: z.int(), offset: z.int() }).optional(),
});

type AgentRequest = z.infer<typeof AgentRequestSchema>;

const encoder = new TextEncoder();

function sendResponse(socket: Socket, value: unknown): void {
  socket.end(encodeJsonFrame(FRAME_TYPES.response, value));
}

function sendError(socket: Socket, code: string): void {
  sendResponse(socket, { error: { code, message: code.toLowerCase() } });
}

interface Follow {
  readonly service: string;
  readonly socket: Socket;
  closed: boolean;
}

// A guest's services. Each log is one file (inode 7), sent from the
// cursor's offset or whole, then a CURSOR; `writeLog` sends what it adds to
// each follow. An agent from before the API knows only services.list.
function buildServiceAgent(knowsServices: boolean) {
  const services: AgentService[] = [];
  const requests: AgentRequest[] = [];

  // bytes, as in the guest's file
  const logs = new Map<string, Buffer>();

  // the agent refuses every log open, or every list, while it is set
  const failing = { logs: false, list: false };
  const follows: Follow[] = [];

  const toService = (def: z.infer<typeof AgentDefSchema>): AgentService => ({
    name: def.name,
    state: 'running',
    pid: 40 + services.length,
    restarts: 0,
    ...(knowsServices && {
      def: { ...def, restart: def.restart ?? 'always', source: 'api' as const },
      root: (def.user ?? IMAGE_USER) === 'root',
    }),
  });

  const sendLog = (socket: Socket, data: Uint8Array, end: number): void => {
    socket.write(encodeFrame(FRAME_TYPES.stdout, data));
    socket.write(encodeJsonFrame(FRAME_TYPES.cursor, { inode: LOG_INODE, offset: end }));
  };

  const handleLogs = (socket: Socket, request: Readonly<AgentRequest>): void => {
    const service = request.service ?? '';
    const log = logs.get(service) ?? Buffer.alloc(0);
    const from = request.cursor?.offset ?? 0;

    if (failing.logs) {
      sendError(socket, 'INTERNAL');

      return;
    }

    socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));

    if (from < log.length) {
      sendLog(socket, log.subarray(from), log.length);
    }

    if (request.follow !== true) {
      socket.end(encodeFrame(FRAME_TYPES.stdoutEof));

      return;
    }

    const follow: Follow = { service, socket, closed: false };

    follows.push(follow);

    socket.on('close', () => {
      follow.closed = true;
    });
  };

  const handleRequest = (socket: Socket, request: Readonly<AgentRequest>): void => {
    requests.push(request);

    const index = services.findIndex((service) => service.name === request.service);

    if (request.op === 'services.list' && failing.list) {
      sendError(socket, 'INTERNAL');
    } else if (request.op === 'services.list') {
      sendResponse(socket, { services, ...(knowsServices && { image_user: IMAGE_USER }) });
    } else if (!knowsServices) {
      sendError(socket, 'UNKNOWN_OP');
    } else if (request.op === 'services.add' && request.def !== undefined) {
      const def = request.def;
      const taken = services.findIndex((service) => service.name === def.name);

      if (def.argv[0] === 'bad') {
        sendError(socket, 'BAD_REQUEST');
      } else if (taken !== -1 && request.replace !== true) {
        sendError(socket, 'SERVICE_EXISTS');
      } else {
        const at = taken === -1 ? services.length : taken;

        services.splice(at, 1, toService(def));

        sendResponse(socket, { ok: true });
      }
    } else if (index === -1 && !logs.has(request.service ?? '')) {
      sendError(socket, 'NO_SERVICE');
    } else if (request.op === 'services.remove') {
      services.splice(index, 1);

      sendResponse(socket, { ok: true });
    } else if (request.op === 'services.restart') {
      sendResponse(socket, { ok: true });
    } else if (request.op === 'services.logs') {
      handleLogs(socket, request);
    }
  };

  const writeLog = (service: string, text: string | Uint8Array): void => {
    const data = typeof text === 'string' ? encoder.encode(text) : text;
    const log = Buffer.concat([logs.get(service) ?? Buffer.alloc(0), data]);

    logs.set(service, log);

    for (const follow of follows) {
      if (follow.service === service && !follow.closed) {
        sendLog(follow.socket, data, log.length);
      }
    }
  };

  // what a VM going to sleep does to its vsock connections
  const stopFollows = (): void => {
    for (const follow of follows) {
      follow.socket.destroy();
    }
  };

  return { services, requests, logs, follows, failing, handleRequest, writeLog, stopFollows };
}

async function setupServiceTest(knowsServices = true) {
  const harness = await setupImpTest();

  // each boot and wake reports it
  harness.fake.agent.version = knowsServices ? '0.10.0' : '0.9.0';

  const app = buildTestApp(harness, harness);

  await harness.createTestImage('ubuntu');

  const imp = await app.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const agent = buildServiceAgent(knowsServices);
  const paths = buildImpPaths(harness.config.dataDir, imp.id);

  const listening = await startFakeAgent(paths.vsockSocket, (socket, request, frames) => {
    if (frames.length === 1) {
      agent.handleRequest(socket, AgentRequestSchema.parse(decodeJsonPayload(request)));
    }
  });

  // a client with an exec-scope token
  const created = await app.client.tokens.create({ name: 'runner', scope: 'exec' });

  const link = new RPCLink({
    url: 'http://impd.test/rpc',
    headers: { authorization: `Bearer ${created.secret}` },
    fetch: (request) => app.app.handle(request),
  });

  const execClient: ContractRouterClient<ImpContract> = createORPCClient(link);

  return {
    ...harness,
    ...app,
    imp,
    agent,
    execClient,
    async [Symbol.asyncDispose]() {
      listening.close();

      await harness[Symbol.asyncDispose]();
    },
  };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 300; tries += 1) {
    if (condition()) {
      return;
    }

    await Bun.sleep(10);
  }

  throw new Error('the condition never held');
}

function readCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
}

function formatEvent(event: Readonly<ServiceLog>): string {
  if (event.type === 'log') {
    return `${event.service}:${event.text}`;
  }

  return event.type === 'sleeping' ? `sleeping:${event.state}` : event.type;
}

test('an added service lists with its command, its source, and only its env keys', async () => {
  await using ctx = await setupServiceTest();

  await ctx.client.services.add({
    name: 'dev',
    service: { name: 'web', argv: ['node', 'server.js'], env: ['PORT=3000', 'TOKEN=s3cret'] },
  });

  const [web] = ctx.agent.services;

  if (web === undefined) {
    throw new Error('no service');
  }

  ctx.agent.services[0] = { ...web, last_exit: { code: 137, signal: 9 } };

  const listed = await ctx.client.services.list({ name: 'dev' });

  const services = listed.services;

  expect(ctx.agent.requests.find((request) => request.op === 'services.add')?.def).toEqual({
    name: 'web',
    argv: ['node', 'server.js'],
    env: ['PORT=3000', 'TOKEN=s3cret'],
  });

  expect(listed.recorded).toBe(true);

  expect(services).toEqual([
    {
      name: 'web',
      state: 'running',
      pid: 40,
      restarts: 0,
      lastExit: { code: 137, signal: 'SIGKILL' },
      argv: ['node', 'server.js'],
      envKeys: ['PORT', 'TOKEN'],
      cwd: null,
      user: null,
      restart: 'always',
      source: 'api',
      root: false,
    },
  ]);

  expect(JSON.stringify(services)).not.toContain('s3cret');
});

test('an add of a service that exists is CONFLICT unless it replaces', async () => {
  await using ctx = await setupServiceTest();

  const service = { name: 'web', argv: ['httpd'] };

  await ctx.client.services.add({ name: 'dev', service });

  const rejection = await readRejection(ctx.client.services.add({ name: 'dev', service }));

  await ctx.client.services.add({
    name: 'dev',
    service: { ...service, argv: ['httpd', '-v'] },
    replace: true,
  });

  expect(rejection).toMatchObject({ code: 'CONFLICT', data: { kind: 'service', name: 'web' } });
  expect(ctx.agent.services.map((entry) => entry.def?.argv)).toEqual([['httpd', '-v']]);
});

test('the agent’s refusals come back as the API’s errors', async () => {
  await using ctx = await setupServiceTest();

  const bad = await readRejection(
    ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['bad'] } }),
  );

  const removed = await readRejection(ctx.client.services.remove({ name: 'dev', service: 'web' }));

  const restarted = await readRejection(
    ctx.client.services.restart({ name: 'dev', service: 'web' }),
  );

  expect(bad).toMatchObject({ code: 'BAD_REQUEST' });
  expect(removed).toMatchObject({ code: 'NOT_FOUND', data: { kind: 'service', name: 'web' } });
  expect(restarted).toMatchObject({ code: 'NOT_FOUND', data: { kind: 'service' } });
});

test('a name that is not a plain lowercase file name is refused before the agent', async () => {
  await using ctx = await setupServiceTest();

  const names = ['../x', 'a_b', 'a.b', 'Web', `a${'b'.repeat(63)}`];

  const rejections = await Promise.all(
    names.map((name) =>
      readRejection(ctx.client.services.add({ name: 'dev', service: { name, argv: ['x'] } })),
    ),
  );

  const remove = await readRejection(ctx.client.services.remove({ name: 'dev', service: 'a/b' }));

  expect(rejections.map((rejection) => readCode(rejection))).toEqual(
    names.map(() => 'BAD_REQUEST'),
  );

  expect(remove).toMatchObject({ code: 'BAD_REQUEST' });
  expect(ctx.agent.requests).toEqual([]);
});

test('with the exec scope, a service runs as the image user and root ones stay put', async () => {
  await using ctx = await setupServiceTest();

  const asRoot = await readRejection(
    ctx.execClient.services.add({
      name: 'dev',
      service: { name: 'web', argv: ['httpd'], user: 'root' },
    }),
  );

  await ctx.execClient.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  await ctx.execClient.services.add({
    name: 'dev',
    service: { name: 'job', argv: ['job'], user: IMAGE_USER },
  });

  await ctx.client.services.add({
    name: 'dev',
    service: { name: 'db', argv: ['postgres'], user: 'root' },
  });

  const calls = [
    ctx.execClient.services.remove({ name: 'dev', service: 'db' }),
    ctx.execClient.services.restart({ name: 'dev', service: 'db' }),
    ctx.execClient.services.add({
      name: 'dev',
      service: { name: 'db', argv: ['postgres'] },
      replace: true,
    }),

    // not started yet, so its user is unknown
    ctx.execClient.services.restart({ name: 'dev', service: 'late' }),
  ];

  const refusals = await Promise.all(calls.map((call) => readRejection(call)));

  await ctx.execClient.services.restart({ name: 'dev', service: 'web' });
  await ctx.execClient.services.remove({ name: 'dev', service: 'job' });
  await ctx.client.services.remove({ name: 'dev', service: 'db' });

  expect(asRoot).toMatchObject({ code: 'FORBIDDEN' });
  expect(refusals.map((refusal) => readCode(refusal))).toEqual(calls.map(() => 'FORBIDDEN'));
  expect(ctx.agent.services.map((service) => service.name)).toEqual(['web']);
});

test('an agent from before the services API is AGENT_OUTDATED, and still lists', async () => {
  await using ctx = await setupServiceTest(false);

  ctx.agent.services.push({ name: 'dockerd', state: 'running', pid: 212, restarts: 0 });

  const added = await readRejection(
    ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } }),
  );

  const listed = await ctx.client.services.list({ name: 'dev' });

  const services = listed.services;

  expect(added).toMatchObject({ code: 'AGENT_OUTDATED' });

  expect(services.map((service) => [service.name, service.source, service.root])).toEqual([
    ['dockerd', 'image', true],
  ]);
});

test('logs sends one service’s log, 100 lines by default', async () => {
  await using ctx = await setupServiceTest();

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  ctx.agent.writeLog('web', 'GET /\nGET /favicon.ico\n');

  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web' });

  const events: string[] = [];

  for await (const event of stream) {
    events.push(formatEvent(event));
  }

  expect(events).toEqual(['web:GET /\nGET /favicon.ico\n']);

  expect(ctx.agent.requests.at(-1)).toMatchObject({
    op: 'services.logs',
    service: 'web',
    lines: 100,
    follow: false,
  });
});

test('every service’s log shares 10 000 lines', async () => {
  await using ctx = await setupServiceTest();

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });
  await ctx.client.services.add({ name: 'dev', service: { name: 'db', argv: ['postgres'] } });

  const stream = await ctx.client.services.logs({ name: 'dev', lines: 100_000 });

  for await (const event of stream) {
    expect(event.type).toBe('log');
  }

  const asked = ctx.agent.requests.filter((request) => request.op === 'services.logs');

  expect(asked.map((request) => request.lines)).toEqual([5000, 5000]);
});

test('a follow of every service merges them, and closes each when the reader stops', async () => {
  await using ctx = await setupServiceTest();

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });
  await ctx.client.services.add({ name: 'dev', service: { name: 'db', argv: ['postgres'] } });

  ctx.agent.writeLog('web', 'web line\n');
  ctx.agent.writeLog('db', 'db line\n');

  const stream = await ctx.client.services.logs({ name: 'dev', follow: true, lines: 5 });

  const seen = new Set<string>();

  for await (const event of stream) {
    seen.add(formatEvent(event));

    if (seen.size === 2) {
      break;
    }
  }

  await waitUntil(() => ctx.agent.follows.length === 2 && ctx.agent.follows.every((f) => f.closed));

  expect([...seen].toSorted()).toEqual(['db:db line\n', 'web:web line\n']);
});

test('a follow waits out a sleep without a wake, and goes on from its cursor', async () => {
  await using ctx = await setupServiceTest();

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  ctx.agent.writeLog('web', 'one\n');

  const before = await ctx.client.imps.get({ name: 'dev' });
  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web', follow: true });

  const iterator = stream[Symbol.asyncIterator]();
  const events: string[] = [];

  const readEvent = async (): Promise<void> => {
    const next = await iterator.next();

    if (next.done !== true) {
      events.push(formatEvent(next.value));
    }
  };

  await readEvent();

  // the VM goes to sleep and its connections end; a line the stream had
  // not sent yet waits in the log
  await ctx.client.imps.sleep({ name: 'dev' });

  ctx.agent.stopFollows();
  ctx.agent.writeLog('web', 'two\n');

  await readEvent();

  const asleep = await ctx.client.imps.get({ name: 'dev' });

  await ctx.client.imps.wake({ name: 'dev' });

  await readEvent();
  await readEvent();

  ctx.agent.writeLog('web', 'three\n');

  await readEvent();

  await iterator.return?.();

  const resumed = ctx.agent.requests.findLast((request) => request.op === 'services.logs');

  expect(events).toEqual(['web:one\n', 'sleeping:sleeping', 'awake', 'web:two\n', 'web:three\n']);
  expect(asleep.state).toBe('sleeping');
  expect(ctx.fake.wakes).toHaveLength(1);
  expect(resumed?.cursor).toEqual({ inode: LOG_INODE, offset: 4 });
  expect(asleep.lastActiveAt).toEqual(before.lastActiveAt);
});

test('a follow of a sleeping imp does not wake it', async () => {
  await using ctx = await setupServiceTest();

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });
  await ctx.client.imps.sleep({ name: 'dev' });

  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web', follow: true });

  const iterator = stream[Symbol.asyncIterator]();

  const first = await iterator.next();

  await iterator.return?.();

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(first.value).toEqual({ type: 'sleeping', state: 'sleeping' });
  expect(imp.state).toBe('sleeping');
  expect(ctx.fake.wakes).toEqual([]);
});

test('a list of a sleeping imp is the one its sleep recorded, and wakes nothing', async () => {
  await using ctx = await setupServiceTest();

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });
  await ctx.client.imps.sleep({ name: 'dev' });

  const asleep = await ctx.client.services.list({ name: 'dev' });

  await ctx.client.imps.stop({ name: 'dev' });

  const stopped = await ctx.client.services.list({ name: 'dev' }).catch(readCode);
  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(asleep.services.map((service) => [service.name, service.state])).toEqual([
    ['web', 'running'],
  ]);

  expect(asleep.recorded).toBe(true);
  expect(stopped).toBe('INVALID_STATE');
  expect(imp.state).toBe('stopped');
  expect(ctx.fake.wakes).toEqual([]);
});

test('a sleep the agent gave no list to lists none, and says it recorded none', async () => {
  await using ctx = await setupServiceTest();

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  ctx.agent.failing.list = true;

  await ctx.client.imps.sleep({ name: 'dev' });

  const asleep = await ctx.client.services.list({ name: 'dev' });

  expect(asleep).toEqual({ services: [], recorded: false });
});

test('a follow keeps a character split across a sleep whole', async () => {
  await using ctx = await setupServiceTest();

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  // é is 0xc3 0xa9: the sleep falls between its two bytes
  ctx.agent.writeLog('web', new Uint8Array([0x61, 0xc3]));

  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web', follow: true });

  const iterator = stream[Symbol.asyncIterator]();
  const events: string[] = [];

  const readEvent = async (): Promise<void> => {
    const next = await iterator.next();

    if (next.done !== true) {
      events.push(formatEvent(next.value));
    }
  };

  await readEvent();

  await ctx.client.imps.sleep({ name: 'dev' });

  ctx.agent.stopFollows();
  ctx.agent.writeLog('web', new Uint8Array([0xa9, 0x0a]));

  await readEvent();

  await ctx.client.imps.wake({ name: 'dev' });

  await readEvent();
  await readEvent();

  await iterator.return?.();

  expect(events).toEqual(['web:a', 'sleeping:sleeping', 'awake', 'web:é\n']);
});

test('a follow goes on soon after a wake whose event a listener delays', async () => {
  await using ctx = await setupServiceTest();

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  // a write per wake: the event then reaches the follow while the wake
  // still holds the imp
  const unsubscribe = subscribeImpWrites(ctx.db, (write) => {
    if (write.kind === 'changed' && write.reason === 'woke') {
      void updateImpActivity(ctx.db, write.imp.id, new Date());
    }
  });

  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web', follow: true });

  const iterator = stream[Symbol.asyncIterator]();

  await ctx.client.imps.sleep({ name: 'dev' });

  ctx.agent.stopFollows();

  const asleep = await iterator.next();

  const wokeAt = Date.now();

  await ctx.client.imps.wake({ name: 'dev' });

  const awake = await iterator.next();

  const waitedMs = Date.now() - wokeAt;

  await iterator.return?.();

  unsubscribe();

  expect(asleep.value).toEqual({ type: 'sleeping', state: 'sleeping' });
  expect(awake.value).toEqual({ type: 'awake' });
  expect(waitedMs).toBeLessThan(2000);
});

test('a follow ends with the error when its log keeps failing to open', async () => {
  await using ctx = await setupServiceTest();

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  ctx.agent.writeLog('web', 'one\n');

  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web', follow: true });

  const events: string[] = [];

  const read = async (): Promise<void> => {
    for await (const event of stream) {
      events.push(formatEvent(event));

      // the connection drops while the imp runs, and every open after it fails
      ctx.agent.failing.logs = true;

      ctx.agent.stopFollows();
    }
  };

  const error = await read().then(() => null, readCode);

  const opens = ctx.agent.requests.filter((request) => request.op === 'services.logs');

  expect(events).toEqual(['web:one\n']);
  expect(error).not.toBeNull();
  expect(opens).toHaveLength(6);
}, 10_000);

test('an impd restart ends a follow with restarting', async () => {
  await using ctx = await setupServiceTest();

  await ctx.client.services.add({ name: 'dev', service: { name: 'web', argv: ['httpd'] } });

  ctx.agent.writeLog('web', 'one\n');

  const stream = await ctx.client.services.logs({ name: 'dev', service: 'web', follow: true });

  const events: string[] = [];

  for await (const event of stream) {
    events.push(formatEvent(event));

    if (event.type === 'log') {
      ctx.imps.endLogFollows();
    }
  }

  expect(events).toEqual(['web:one\n', 'restarting']);
});
