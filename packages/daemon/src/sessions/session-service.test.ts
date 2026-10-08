import { expect, onTestFinished, test } from 'bun:test';
import type { Socket } from 'node:net';
import * as z from 'zod';
import type { AgentSession } from '../agent-client/agent-requests';
import { FRAME_TYPES, decodeJsonPayload, encodeJsonFrame } from '../agent-client/frame-codec';
import { findImpByName } from '../db/imps';
import { buildTestApp, createImpTest } from '../imps/test-imps';
import { readRejection } from '../read-rejection';
import { readSnapshotMeta } from '../sleep/snapshot-meta';
import { buildImpPaths } from '../storage/data-layout';
import { startStubAgent } from '../test-utils/start-stub-agent';

const STARTED_AT = Date.UTC(2026, 9, 2, 12, 0, 0);

function buildSession(name: string, change: Readonly<Partial<AgentSession>> = {}): AgentSession {
  return {
    name,
    pid: 300,
    argv: ['bash', '-l'],
    state: 'running',
    attached: false,
    cols: 120,
    rows: 40,
    started_unix_ms: STARTED_AT,
    ...change,
  };
}

const AgentRequestSchema = z.object({ op: z.string(), session: z.string().optional() });

type AgentRequest = z.infer<typeof AgentRequestSchema>;

function sendResponse(socket: Socket, value: unknown): void {
  socket.end(encodeJsonFrame(FRAME_TYPES.response, value));
}

// An agent that answers activity with `sessions` and kills by name; one
// from before sessions knows no session.kill.
function buildSessionAgent(initial: readonly AgentSession[], knowsKill: boolean) {
  const sessions = [...initial];
  const ops: string[] = [];

  const handleRequest = (socket: Socket, request: Readonly<AgentRequest>): void => {
    ops.push(request.op);

    if (request.op === 'activity') {
      sendResponse(socket, { tcp_established: 0, exec_sessions: 0, load1: 0, sessions });

      return;
    }

    if (request.op !== 'session.kill' || !knowsKill) {
      sendResponse(socket, { error: { code: 'UNKNOWN_OP', message: 'unknown op' } });

      return;
    }

    const index = sessions.findIndex((session) => session.name === request.session);

    if (index === -1) {
      sendResponse(socket, { error: { code: 'NO_SESSION', message: 'no session' } });

      return;
    }

    sessions.splice(index, 1);

    sendResponse(socket, { ok: true });
  };

  return { sessions, ops, handleRequest };
}

async function setupSessionTest(sessions: readonly AgentSession[], knowsKill = true) {
  // one stack: the stub agent closes before the harness it serves
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  const app = buildTestApp(harness, harness);

  await harness.createTestImage('ubuntu');

  const imp = await app.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const agent = buildSessionAgent(sessions, knowsKill);

  const listening = await startStubAgent(
    buildImpPaths(harness.config.dataDir, imp.id).vsockSocket,
    (socket, request, frames) => {
      if (frames.length === 1) {
        agent.handleRequest(socket, AgentRequestSchema.parse(decodeJsonPayload(request)));
      }
    },
  );

  stack.defer(() => {
    listening.close();
  });

  return {
    ...harness,
    ...app,
    imp,
    agent,
  };
}

test('it lists a running imp’s sessions from its agent', async () => {
  const ctx = await setupSessionTest([
    buildSession('main', { attached: true }),
    buildSession('job', { state: 'exited', exit: { code: 137, signal: 9 } }),
  ]);

  const before = await ctx.client.imps.get({ name: 'dev' });
  const sessions = await ctx.client.sessions.list({ name: 'dev' });

  expect(sessions).toEqual([
    {
      name: 'main',
      pid: 300,
      argv: ['bash', '-l'],
      state: 'running',
      attached: true,
      cols: 120,
      rows: 40,
      startedAt: new Date(STARTED_AT),
      continuity: 'none',
    },
    {
      name: 'job',
      pid: 300,
      argv: ['bash', '-l'],
      state: 'exited',
      attached: false,
      cols: 120,
      rows: 40,
      startedAt: new Date(STARTED_AT),
      exit: { code: null, signal: 'SIGKILL' },
      continuity: 'none',
    },
  ]);

  // impd has not seen the agent before the list; it counts them after
  const after = await ctx.client.imps.get({ name: 'dev' });
  const info = await ctx.client.system.info();

  expect(before.sessions).toBeUndefined();
  expect(after.sessions).toBe(2);
  expect(info.sessionCount).toBe(2);
});

test('the idle loop’s activity read records the sessions', async () => {
  const ctx = await setupSessionTest([buildSession('main')]);
  const record = await findImpByName(ctx.db, 'dev');

  if (record === undefined) {
    throw new Error('no imp');
  }

  const activity = await ctx.imps.readActivity(record);
  const imps = await ctx.client.imps.list();

  expect(activity?.sessions.map((session) => session.name)).toEqual(['main']);
  expect(imps[0]?.sessions).toBe(1);
});

test('a sleeping imp lists the sessions it went to sleep with, without a wake', async () => {
  const ctx = await setupSessionTest([buildSession('main', { attached: true })]);

  await ctx.client.imps.sleep({ name: 'dev' });

  const meta = readSnapshotMeta(buildImpPaths(ctx.config.dataDir, ctx.imp.id));

  expect(meta?.sessions).toMatchObject([buildSession('main', { attached: false })]);
  expect(meta?.sessions?.[0]?.observed_unix_ms).toBeNumber();

  ctx.agent.ops.length = 0;

  const sessions = await ctx.client.sessions.list({ name: 'dev' });
  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(sessions.map((session) => [session.name, session.attached])).toEqual([['main', false]]);
  expect(imp.state).toBe('sleeping');
  expect(imp.sessions).toBe(1);
  expect(ctx.fake.wakes).toEqual([]);
  expect(ctx.agent.ops).toEqual([]);
});

test('a stopped imp has no sessions', async () => {
  const ctx = await setupSessionTest([buildSession('main')]);

  await ctx.client.sessions.list({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });

  const sessions = await ctx.client.sessions.list({ name: 'dev' });
  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(sessions).toEqual([]);
  expect(imp.sessions).toBe(0);
});

test('a kill wakes a sleeping imp and ends the session', async () => {
  const ctx = await setupSessionTest([buildSession('main'), buildSession('other')]);

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.sessions.kill({ name: 'dev', session: 'main' });

  expect(ctx.fake.wakes).toHaveLength(1);
  expect(ctx.agent.ops).toContain('session.kill');

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(ctx.agent.sessions.map((session) => session.name)).toEqual(['other']);
  expect(imp.state).toBe('running');
});

test('a kill of no such session is NOT_FOUND', async () => {
  const ctx = await setupSessionTest([]);
  const rejection = await readRejection(ctx.client.sessions.kill({ name: 'dev', session: 'main' }));

  expect(rejection).toMatchObject({ code: 'NOT_FOUND', data: { kind: 'session', name: 'main' } });
});

test('a kill on an agent from before sessions is AGENT_OUTDATED', async () => {
  const ctx = await setupSessionTest([], false);
  const rejection = await readRejection(ctx.client.sessions.kill({ name: 'dev', session: 'main' }));

  expect(rejection).toMatchObject({ code: 'AGENT_OUTDATED', status: 409 });
});

test('a list of an unknown imp is NOT_FOUND', async () => {
  const ctx = await setupSessionTest([]);
  const rejection = await readRejection(ctx.client.sessions.list({ name: 'nope' }));

  expect(rejection).toMatchObject({ code: 'NOT_FOUND', data: { kind: 'imp', name: 'nope' } });
});

test('a session from an agent with offsets lists its generation and its end as last seen', async () => {
  const generation = 'b'.repeat(32);

  const ctx = await setupSessionTest([
    buildSession('main', {
      execution_generation: generation,
      boot_id: '22222222-2222-4222-8222-222222222222',
      end: 4096,
    }),
  ]);

  const before = Date.now();

  const [session] = await ctx.client.sessions.list({ name: 'dev' });

  expect(session).toMatchObject({
    continuity: 'offsets',
    executionGeneration: generation,
    bootId: '22222222-2222-4222-8222-222222222222',
    end: 4096,
  });

  expect(session?.endObservedAt?.getTime()).toBeGreaterThanOrEqual(before);

  // a sleep keeps the generation and when impd saw the end
  await ctx.client.imps.sleep({ name: 'dev' });

  const [slept] = await ctx.client.sessions.list({ name: 'dev' });

  expect(slept).toMatchObject({
    continuity: 'offsets',
    executionGeneration: generation,
    end: 4096,
  });

  expect(slept?.endObservedAt?.getTime()).toBeGreaterThanOrEqual(before);
});
