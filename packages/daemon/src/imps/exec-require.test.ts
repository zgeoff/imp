import { expect, onTestFinished, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import * as z from 'zod';
import {
  FRAME_TYPES,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from '../agent-client/frame-codec';
import type { InstallBundle } from '../broker/guest-trust';
import { readVmIdentity, writeVmIdentity } from '../sleep/vm-identity';
import { buildImpPaths } from '../storage/data-layout';
import { startStubAgent } from '../test-utils/start-stub-agent';
import { createImpTest } from './test-imps';

// An exec with `require: ['broker']` starts only once impd set the broker's
// variables and the CA bundle for the boot it starts in.

// the agent's boot, in the uuid form impd checks before it names a log path
const AGENT_BOOT_ID = '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

// what `activity` lists: every session as running
// one run of a fake session: the client attached to it, and whether its
// process exited (a resume of its generation can still attach)
interface FakeRun {
  readonly generation: string;
  viewer: Socket | null;
  state: 'running' | 'exited';
}

// what `activity` lists: every run, exited ones included
function buildActivity(sessions: ReadonlyMap<string, Readonly<FakeRun>>) {
  return {
    tcp_established: 0,
    exec_sessions: sessions.size,
    load1: 0,
    sessions: [...sessions].map(([name, run]) => ({
      name,
      pid: 9,
      argv: ['sh'],
      state: run.state,
      attached: run.viewer !== null,
      cols: 80,
      rows: 24,
      started_unix_ms: 0,
      execution_generation: run.generation,
      boot_id: AGENT_BOOT_ID,
      end: 0,
    })),
  };
}

const ExecFrameSchema = z.looseObject({
  op: z.string(),
  env: z.array(z.string()).optional(),
  session: z.string().optional(),
  resume_from: z.object({ execution_generation: z.string() }).optional(),
});

const RefusalSchema = z.object({
  code: z.literal('PRECONDITION_FAILED'),
  data: z.object({ reason: z.literal('broker_not_ready'), detail: z.string() }),
});

// the detail of a broker refusal; anything else fails the test
async function readRefusal(opening: Promise<{ readonly close: () => void }>): Promise<string> {
  try {
    const stream = await opening;

    stream.close();
  } catch (error) {
    return RefusalSchema.parse(error).data.detail;
  }

  throw new Error('the exec started');
}

async function setupRequireTest(installBundle?: InstallBundle) {
  const options = installBundle === undefined ? {} : { installBundle };

  // one stack: the stub agent closes before the harness it serves
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const ctx = await createImpTest(stack, options);

  await ctx.createTestImage('base');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  // the fake agent's sessions, by name: each run's generation, and the
  // socket of the client attached to it
  const sessions = new Map<string, FakeRun>();

  // The agent: `activity` lists the sessions; an exec answers STARTED. A
  // start with a new session name creates it, one with a known name attaches
  // and takes it over from its viewer, as the real agent does.
  const agent = await startStubAgent(paths.vsockSocket, (socket, request, frames) => {
    if (frames.length > 1) {
      return;
    }

    const payload = ExecFrameSchema.parse(decodeJsonPayload(request));

    if (payload.op === 'activity') {
      socket.write(encodeJsonFrame(FRAME_TYPES.response, buildActivity(sessions)));

      return;
    }

    const session = payload.session;

    if (session === undefined) {
      socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 9 }));

      return;
    }

    const found = sessions.get(session);

    // an exited run takes an attach only from a resume of its generation
    const known =
      found?.state === 'running' || found?.generation === payload.resume_from?.execution_generation
        ? found
        : undefined;

    const run: FakeRun = known ?? {
      generation: randomBytes(16).toString('hex'),
      viewer: null,
      state: 'running',
    };

    known?.viewer?.end(encodeJsonFrame(FRAME_TYPES.detached, { reason: 'taken_over' }));
    run.viewer = socket;

    sessions.set(session, run);

    socket.write(
      encodeJsonFrame(FRAME_TYPES.started, {
        pid: 9,
        session,
        created: known === undefined,
        output: {
          boot_id: AGENT_BOOT_ID,
          execution_generation: run.generation,
          buffer_start: 0,
          end: 0,
          offset: 0,
          prelude: 0,
        },
      }),
    );
  });

  stack.defer(() => {
    agent.close();
  });

  const createGrant = async () => {
    await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
    await ctx.broker.addGrant('dev', 'gh');
  };

  // the exec requests the agent got, not its activity requests
  const readExecs = () =>
    agent.received
      .map((frame) => ExecFrameSchema.parse(decodeJsonPayload(frame)))
      .filter((frame) => frame.op === 'exec');

  // an imp's agent that runs sessions (fake VMs record an older one)
  const writeSessionAgent = () => {
    const identity = readVmIdentity(paths);

    if (identity === null) {
      throw new Error('no vm identity');
    }

    writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });
  };

  return {
    ...ctx,
    sessions,
    createGrant,
    writeSessionAgent,
    readExecs,
  };
}

const REQUIRED = { argv: ['true'], tty: false, require: ['broker'] } as const;

test('without a grant, an exec that requires the broker starts nothing', async () => {
  const ctx = await setupRequireTest();
  const refused = await readRefusal(ctx.imps.openExec('dev', REQUIRED));

  expect(refused).toContain('no grant');
  expect(ctx.readExecs()).toEqual([]);

  // the same exec without the requirement runs as before
  const stream = await ctx.imps.openExec('dev', { argv: ['true'], tty: false });

  stream.close();

  expect(ctx.readExecs()).toHaveLength(1);
});

test('a failed CA bundle step refuses the exec, and the next exec tries it again', async () => {
  const state = { fail: true };

  const ctx = await setupRequireTest(() =>
    state.fail ? Promise.reject(new Error('no /bin/sh')) : Promise.resolve(),
  );

  await ctx.createGrant();

  const refused = await readRefusal(ctx.imps.openExec('dev', REQUIRED));

  expect(refused).toContain('no /bin/sh');
  expect(ctx.readExecs()).toEqual([]);

  state.fail = false;

  const stream = await ctx.imps.openExec('dev', REQUIRED);

  stream.close();

  expect(ctx.readExecs()[0]?.env).toContain('HTTPS_PROXY=http://10.66.0.1:7081');

  // the requirement is impd's to check, not the agent's
  expect(ctx.readExecs()[0]).not.toHaveProperty('require');
});

test('the bundle step runs before the first exec of a boot, and again after a reboot', async () => {
  const ctx = await setupRequireTest();

  await ctx.createGrant();

  const first = await ctx.imps.openExec('dev', REQUIRED);

  first.close();

  expect(ctx.bundleInstalls).toHaveLength(1);

  const env = ctx.readExecs()[0]?.env;

  expect(env).toContain('HTTPS_PROXY=http://10.66.0.1:7081');
  expect(env).toContain('SSL_CERT_FILE=/etc/imp/broker-ca.pem');

  // a restore halts the guest and boots it again: a new boot
  await ctx.imps.lockImp('dev', async (imp) => {
    const halted = await ctx.imps.haltImp(imp, false);

    await ctx.imps.bootImp(halted);
  });

  const second = await ctx.imps.openExec('dev', REQUIRED);

  second.close();

  expect(ctx.bundleInstalls).toHaveLength(2);
});

test('an env that replaces a broker variable is refused, and names it', async () => {
  const ctx = await setupRequireTest();

  await ctx.createGrant();

  const refused = await readRefusal(
    ctx.imps.openExec('dev', { ...REQUIRED, env: ['SSL_CERT_FILE=/tmp/mine.pem'] }),
  );

  expect(refused).toContain('SSL_CERT_FILE');
  expect(ctx.readExecs()).toEqual([]);

  // a variable the broker does not set is the caller's to give
  const stream = await ctx.imps.openExec('dev', { ...REQUIRED, env: ['TERM=xterm'] });

  stream.close();

  expect(ctx.readExecs()).toHaveLength(1);
});

test('an outer exec never meets the broker requirement', async () => {
  const ctx = await setupRequireTest();

  await ctx.createGrant();

  const refused = await readRefusal(
    ctx.imps.openExec('dev', { ...REQUIRED, outer: true }, 'outer-exec'),
  );

  expect(refused).toContain('in the agent');
  expect(ctx.readExecs()).toEqual([]);
});

test('no lifecycle operation runs between the bundle step and the start', async () => {
  const install: { release: () => void; reached: () => void } = {
    release: () => {},
    reached: () => {},
  };

  const reached = new Promise<void>((resolve) => {
    install.reached = resolve;
  });

  const ctx = await setupRequireTest(
    () =>
      new Promise<void>((resolve) => {
        install.release = resolve;

        install.reached();
      }),
  );

  await ctx.createGrant();

  const order: string[] = [];

  const exec = (async () => {
    const stream = await ctx.imps.openExec('dev', REQUIRED);

    order.push(`exec started (${String(ctx.readExecs().length)} sent)`);
    stream.close();
  })();

  await reached;

  // as a restore would: it must wait for the exec to start
  const locked = ctx.imps.lockImp('dev', () => {
    order.push('lifecycle');

    return Promise.resolve();
  });

  await Bun.sleep(20);

  expect(order).toEqual([]);

  install.release();

  await Promise.all([exec, locked]);

  expect(order).toEqual(['exec started (1 sent)', 'lifecycle']);
});

test('a stop that takes the lock first leaves the exec to boot the imp and check again', async () => {
  const ctx = await setupRequireTest();

  await ctx.createGrant();

  const order: string[] = [];

  // the exec finds the imp running, then the stop takes the lock before
  // the exec's bundle step does
  const opening = ctx.imps.openExec('dev', REQUIRED);

  const stopping = ctx.imps.lockImp('dev', async (imp) => {
    await ctx.imps.haltImp(imp, false);

    order.push('stopped');
  });

  const stream = await opening;

  stream.close();

  await stopping;

  expect(order).toEqual(['stopped']);
  expect(ctx.bundleInstalls).toHaveLength(1);
  expect(ctx.readExecs()[0]?.env).toContain('HTTPS_PROXY=http://10.66.0.1:7081');
});

// a start of a session as a console opens it
function buildSessionStart(session: string, required: boolean) {
  return {
    argv: ['sh'],
    tty: true,
    session,
    ...(required && { require: ['broker'] as const }),
  };
}

test('an attach that requires the broker passes only to a session started with it', async () => {
  const ctx = await setupRequireTest();

  ctx.writeSessionAgent();

  const ungranted = await readRefusal(ctx.imps.openExec('dev', buildSessionStart('main', true)));

  expect(ungranted).toContain('no grant');
  expect(ctx.readExecs()).toEqual([]);

  await ctx.createGrant();

  // started with the requirement, then attached to with it
  for (let index = 0; index < 2; index += 1) {
    const stream = await ctx.imps.openExec('dev', buildSessionStart('main', true));

    stream.close();
  }

  // started without it: an attach that requires the broker is refused
  const plain = await ctx.imps.openExec('dev', buildSessionStart('other', false));
  const refused = await readRefusal(ctx.imps.openExec('dev', buildSessionStart('other', true)));

  expect(refused).toBe('session other was started without the broker requirement');

  // before the agent saw it: the viewer still has the session and its output
  expect(ctx.readExecs()).toHaveLength(3);
  ctx.sessions.get('other')?.viewer?.write(encodeFrame(FRAME_TYPES.stdout, Buffer.from('still')));
  const events = plain.events();

  const first = await events.next();

  plain.close();

  expect(first.value).toEqual({ type: 'stdout', data: Buffer.from('still') });
});

test('an attach after an impd restart passes; one after a cold boot does not', async () => {
  const ctx = await setupRequireTest();

  ctx.writeSessionAgent();

  await ctx.createGrant();

  const started = await ctx.imps.openExec('dev', buildSessionStart('main', true));

  started.close();

  // a new impd adopts the running VM and its sessions
  const restarted = ctx.restartImpd();

  await restarted.imps.reconcileImps();

  const resumed = await restarted.imps.openExec('dev', buildSessionStart('main', true));

  resumed.close();

  // a cold boot: the guest's sessions are gone, and one started without
  // the requirement takes the name
  await restarted.imps.lockImp('dev', async (imp) => {
    const halted = await restarted.imps.haltImp(imp, false);

    await restarted.imps.bootImp(halted);
  });

  ctx.sessions.clear();
  ctx.writeSessionAgent();

  const plain = await restarted.imps.openExec('dev', buildSessionStart('main', false));

  plain.close();

  const refused = await readRefusal(
    restarted.imps.openExec('dev', buildSessionStart('main', true)),
  );

  expect(refused).toBe('session main was started without the broker requirement');
});

test('a run that exited keeps its record while it is listed, so a resume of it passes', async () => {
  const ctx = await setupRequireTest();

  ctx.writeSessionAgent();

  await ctx.createGrant();

  const first = await ctx.imps.openExec('dev', buildSessionStart('main', true));

  const generation = ctx.sessions.get('main')?.generation ?? '';

  first.close();

  // main exits while detached; another required session starts after it
  const main = ctx.sessions.get('main');

  if (main !== undefined) {
    main.state = 'exited';
    main.viewer = null;
  }

  const other = await ctx.imps.openExec('dev', buildSessionStart('other', true));

  other.close();

  const resumed = await ctx.imps.openExec('dev', {
    ...buildSessionStart('main', true),
    resumeFrom: { executionGeneration: generation, offset: 0 },
  });

  resumed.close();

  expect(ctx.readExecs()).toHaveLength(3);
});

test('a resume of an exited run started without the requirement is refused before the agent', async () => {
  const ctx = await setupRequireTest();

  ctx.writeSessionAgent();

  await ctx.createGrant();

  const plain = await ctx.imps.openExec('dev', buildSessionStart('job', false));

  const job = ctx.sessions.get('job');

  plain.close();

  if (job !== undefined) {
    job.state = 'exited';
    job.viewer = null;
  }

  const refused = await readRefusal(
    ctx.imps.openExec('dev', {
      ...buildSessionStart('job', true),
      resumeFrom: { executionGeneration: job?.generation ?? '', offset: 0 },
    }),
  );

  expect(refused).toBe('session job was started without the broker requirement');

  // the agent never saw the resume, so it kept the exited run's output
  expect(ctx.readExecs()).toHaveLength(1);
});
