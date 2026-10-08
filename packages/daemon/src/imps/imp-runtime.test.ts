import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { FRAME_TYPES, decodeJsonPayload, encodeJsonFrame } from '../agent-client/frame-codec';
import { findImpByName, updateImpActivity } from '../db/imps';
import { writeLease } from '../db/leases';
import type { ImpDatabase } from '../db/open-database';
import { readVmIdentity, writeVmIdentity } from '../sleep/vm-identity';
import { buildImpPaths } from '../storage/data-layout';
import { startStubAgent } from '../test-utils/start-stub-agent';
import { createImpTest, setupImpTest, waitForOutcome } from './test-imps';

// these tests wait up to 10 s for held calls to settle; a loaded host is slow
const SLOW_TEST_TIMEOUT_MS = 30_000;

// a hold from now for `ms`, as `imps.hold` writes it
async function holdFor(db: ImpDatabase, impId: string, ms: number): Promise<void> {
  const at = Date.now();

  await writeLease(
    db,
    {
      impId,
      principal: 'token:test-token-id',
      label: 'hold',
      display: 'test',
      until: new Date(at + ms),
      createdAt: new Date(at),
    },
    { at, reason: 'held' },
  );
}

async function setupRunningImp(env: Readonly<Record<string, string>> = {}) {
  // one stack: an agent a test starts closes before the harness
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const ctx = await createImpTest(stack, { env });

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  return { ...ctx, impId: imp.id, stack };
}

test('a background sleep skips an imp that was held after the caller looked', async () => {
  const ctx = await setupRunningImp();

  const id = ctx.impId;

  const seen = await findImpByName(ctx.db, 'dev');

  await holdFor(ctx.db, id, 60_000);

  const byIdle = await ctx.imps.trySleepImp(id, 'idle', {
    by: 'idle',
    seenActiveAt: seen?.lastActiveAt.getTime() ?? 0,
  });

  const byGovernor = await ctx.imps.trySleepImp(id, 'budget', { by: 'governor' });

  expect([byIdle, byGovernor]).toEqual(['skipped', 'skipped']);
});

test('the idle loop skips an imp active since it looked; the governor does not', async () => {
  const ctx = await setupRunningImp();

  const id = ctx.impId;

  const seen = await findImpByName(ctx.db, 'dev');

  const seenActiveAt = seen?.lastActiveAt.getTime() ?? 0;

  await updateImpActivity(ctx.db, id, new Date(seenActiveAt + 1000));

  const byIdle = await ctx.imps.trySleepImp(id, 'idle', { by: 'idle', seenActiveAt });
  const byGovernor = await ctx.imps.trySleepImp(id, 'budget', { by: 'governor' });

  expect([byIdle, byGovernor]).toEqual(['skipped', 'slept']);
});

test('a background sleep skips an imp with an open connection or a taken lock', async () => {
  const ctx = await setupRunningImp();

  const id = ctx.impId;
  const release = ctx.imps.tracker.open(id, 'proxy');

  const connected = await ctx.imps.trySleepImp(id, 'budget', { by: 'governor' });

  release();

  const gate = Promise.withResolvers<void>();
  const holding = ctx.imps.lockImp('dev', () => gate.promise);

  await Bun.sleep(5);

  const locked = await ctx.imps.trySleepImp(id, 'budget', { by: 'governor' });

  gate.resolve();

  await holding;

  expect([connected, locked]).toEqual(['skipped', 'skipped']);
});

test('a sleep right after a cold boot waits until the guest is old enough', async () => {
  const ctx = await setupRunningImp({ IMP_SLEEP_MIN_GUEST_UPTIME_MS: '300' });

  ctx.fake.setGuestUptime(100);

  const started = performance.now();

  const asleep = await ctx.imps.sleepImp('dev');

  expect(asleep.state).toBe('sleeping');
  expect(performance.now() - started).toBeGreaterThanOrEqual(190);
  expect(ctx.logs.some((line) => line.includes('for a young guest'))).toBe(true);
});

test('an idle sleep that waits for a young guest gives way to a request', async () => {
  const ctx = await setupRunningImp({ IMP_SLEEP_MIN_GUEST_UPTIME_MS: '5000' });

  ctx.fake.setGuestUptime(0);

  const seen = await findImpByName(ctx.db, 'dev');

  const seenActiveAt = seen?.lastActiveAt.getTime() ?? 0;
  const started = performance.now();
  const sleeping = ctx.imps.trySleepImp(ctx.impId, 'idle', { by: 'idle', seenActiveAt });

  await Bun.sleep(20);

  // as the wake proxy does: the connection counts before it waits for the lock
  const opened = { release: () => {} };

  const request = ctx.imps.requireRunning('dev', (found) => {
    opened.release = ctx.imps.tracker.open(found.id, 'proxy');
  });

  const [outcome, running] = await Promise.all([sleeping, request]);

  opened.release();

  expect(outcome).toBe('skipped');
  expect(running).toMatchObject({ imp: { state: 'running' }, wokeMs: null });
  expect(performance.now() - started).toBeLessThan(2000);
});

test('an idle sleep that waits for a young guest gives way to a hold', async () => {
  const ctx = await setupRunningImp({ IMP_SLEEP_MIN_GUEST_UPTIME_MS: '5000' });

  ctx.fake.setGuestUptime(0);

  const seen = await findImpByName(ctx.db, 'dev');

  const seenActiveAt = seen?.lastActiveAt.getTime() ?? 0;
  const started = performance.now();
  const sleeping = ctx.imps.trySleepImp(ctx.impId, 'idle', { by: 'idle', seenActiveAt });

  await Bun.sleep(20);

  await holdFor(ctx.db, ctx.impId, 60_000);

  const outcome = await sleeping;
  const imp = await findImpByName(ctx.db, 'dev');

  expect(outcome).toBe('skipped');
  expect(imp?.state).toBe('running');
  expect(performance.now() - started).toBeLessThan(2000);
});

test('the governor sleeps young guests at once to admit a boot', async () => {
  // three imps own 300 MiB each; a 720 MiB boot needs all three asleep
  const ctx = await setupImpTest({
    env: {
      IMP_RAM_BUDGET_MIB: '1000',
      IMP_DEFAULT_MEMORY_MIB: '256',
      IMP_BOOT_RESERVE_PERCENT: '100',
      IMP_SLEEP_MIN_GUEST_UPTIME_MS: '5000',
    },
  });

  await ctx.createTestImage('ubuntu');

  for (const name of ['a', 'b', 'c']) {
    await ctx.imps.createImp({ name });
  }

  ctx.fake.setGuestUptime(0);

  const started = performance.now();

  await ctx.imps.createImp({ name: 'big', memoryMib: 720 });

  const imps = await ctx.imps.listImps();

  expect(imps.map((imp) => [imp.name, imp.state])).toEqual([
    ['a', 'sleeping'],
    ['b', 'sleeping'],
    ['big', 'running'],
    ['c', 'sleeping'],
  ]);

  expect(performance.now() - started).toBeLessThan(2000);
});

test('impd stopping sleeps held and connected imps too', async () => {
  const ctx = await setupRunningImp();

  const id = ctx.impId;

  await holdFor(ctx.db, id, 60_000);

  const release = ctx.imps.tracker.open(id, 'exec');

  await ctx.imps.sleepAllImps();

  release();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(imp?.state).toBe('sleeping');
});

test('exec counts its session before the wake and drops it when the wake fails', async () => {
  const ctx = await setupRunningImp();

  const id = ctx.impId;

  await ctx.imps.stopImp('dev');

  const gate = ctx.fake.hold('boot');

  ctx.fake.queue('boot', 'fail');

  const exec = ctx.imps.openExec('dev', { argv: ['true'], tty: false });

  await gate.reached;

  const during = ctx.imps.tracker.count(id, 'exec');

  gate.release();

  const rejection = await exec.catch((error: unknown) => error);

  expect(during).toBe(1);
  expect(rejection).toBeInstanceOf(Error);
  expect(ctx.imps.tracker.count(id)).toBe(0);
});

test('a tunnel counts as a tunnel, not an exec, from before the wake', async () => {
  const ctx = await setupRunningImp();

  const id = ctx.impId;

  await ctx.imps.stopImp('dev');

  const gate = ctx.fake.hold('boot');

  ctx.fake.queue('boot', 'fail');

  const dial = ctx.imps.openDial('dev', { network: 'tcp', address: '127.0.0.1:5432' }, 'tunnel');

  await gate.reached;

  const during = {
    tunnel: ctx.imps.tracker.count(id, 'tunnel'),
    exec: ctx.imps.tracker.count(id, 'exec'),
  };

  gate.release();

  await dial.catch(() => null);

  expect(during).toEqual({ tunnel: 1, exec: 0 });
  expect(ctx.imps.tracker.count(id)).toBe(0);
});

test('impd stopping waits for a boot under way, sleeps that imp, and refuses later boots', async () => {
  const ctx = await setupRunningImp();

  await ctx.imps.stopImp('dev');

  const gate = ctx.fake.hold('boot');
  const starting = ctx.imps.startImp('dev');

  await gate.reached;

  const stopping = ctx.imps.sleepAllImps();

  await Bun.sleep(5);

  gate.release();

  await Promise.all([starting, stopping]);

  const later = await ctx.imps.startImp('dev').catch((error: unknown) => error);
  const imp = await findImpByName(ctx.db, 'dev');

  expect(imp?.state).toBe('sleeping');
  expect(later).toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'impd is stopping' });
});

test(
  'a governor pass during impd stopping neither hangs nor wakes anything',
  async () => {
    const ctx = await setupImpTest({
      env: { IMP_RAM_BUDGET_MIB: '500', IMP_DEFAULT_MEMORY_MIB: '256' },
    });

    await ctx.createTestImage('ubuntu');
    await ctx.imps.createImp({ name: 'a' });
    await ctx.imps.createImp({ name: 'b' });

    const gate = ctx.fake.hold('sleep');

    // 600 MiB awake against a budget of 500: the pass wants one asleep
    const enforcing = ctx.governor.enforce();
    const stopping = ctx.imps.sleepAllImps();

    await gate.reached;

    gate.release();

    const outcomes = await Promise.all([
      waitForOutcome(enforcing, 10_000),
      waitForOutcome(stopping, 10_000),
    ]);

    const imps = await ctx.imps.listImps();

    expect(outcomes).toEqual(['done', 'done']);
    expect(imps.map((imp) => imp.state)).toEqual(['sleeping', 'sleeping']);
  },
  SLOW_TEST_TIMEOUT_MS,
);

test('a create that impd stopping cuts short is recorded as an error', async () => {
  const ctx = await setupRunningImp();

  await ctx.imps.sleepAllImps();

  const rejection = await ctx.imps.createImp({ name: 'late' }).catch((error: unknown) => error);
  const late = await findImpByName(ctx.db, 'late');

  expect(rejection).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  expect(late).toMatchObject({ state: 'error', error: 'impd is stopping' });
});

test('a destroy issued while the create boots waits for it, then removes the imp', async () => {
  const ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');

  const gate = ctx.fake.hold('boot');
  const creating = ctx.imps.createImp({ name: 'dev' });

  await gate.reached;

  const destroying = ctx.imps.destroyImp('dev');

  await Bun.sleep(5);

  gate.release();

  const created = await creating;

  await destroying;

  const left = await findImpByName(ctx.db, 'dev');

  expect(created.state).toBe('running');
  expect(left).toBeUndefined();
  expect(ctx.fake.alive.size).toBe(0);
});

test('a session exec on an agent from before sessions fails before it connects', async () => {
  const ctx = await setupRunningImp();

  const rejection = await ctx.imps
    .openExec('dev', { argv: ['sh'], tty: true, session: 'main' })
    .catch((error: unknown) => error);

  expect(rejection).toMatchObject({ code: 'AGENT_OUTDATED' });
  expect(ctx.imps.tracker.count(ctx.impId)).toBe(0);
});

test('a unix socket dial on an agent from before 0.6.0 fails as AGENT_OUTDATED, a tcp one does not', async () => {
  const ctx = await setupRunningImp();

  const paths = buildImpPaths(ctx.dataDir, ctx.impId);
  const identity = readVmIdentity(paths);

  if (identity === null) {
    throw new Error('no vm identity');
  }

  writeVmIdentity(paths, { ...identity, agentVersion: '0.5.0' });

  const unixDial = await ctx.imps
    .openDial('dev', { network: 'unix', address: '/run/docker.sock' }, 'ssh')
    .catch((error: unknown) => error);

  const tcpDial = await ctx.imps
    .openDial('dev', { network: 'tcp', address: '127.0.0.1:80' }, 'ssh')
    .catch((error: unknown) => error);

  expect(unixDial).toMatchObject({ code: 'AGENT_OUTDATED' });
  expect(tcpDial).not.toMatchObject({ code: 'AGENT_OUTDATED' });
});

test('an outer exec to an older agent is refused before it is sent', async () => {
  const ctx = await setupRunningImp();

  const paths = buildImpPaths(ctx.dataDir, ctx.impId);
  const identity = readVmIdentity(paths);

  if (identity === null) {
    throw new Error('no vm identity');
  }

  const agent = await startStubAgent(paths.vsockSocket, (socket) => {
    socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 9 }));
  });

  ctx.stack.defer(() => {
    agent.close();
  });

  const openOuter = () =>
    ctx.imps.openExec('dev', { argv: ['sh'], tty: true, outer: true }, 'outer-exec');

  // an imp booted before impd recorded versions has no identity file
  rmSync(paths.vmIdentity);

  const missing = await openOuter().catch((error: unknown) => error);

  writeVmIdentity(paths, { ...identity, agentVersion: 'dev' });

  const unparsed = await openOuter().catch((error: unknown) => error);

  writeVmIdentity(paths, { ...identity, agentVersion: '0.15.0' });

  const older = await openOuter().catch((error: unknown) => error);

  expect(String(missing)).toContain('no record of the imp');

  expect([missing, unparsed, older]).toEqual([
    expect.objectContaining({ code: 'AGENT_OUTDATED' }),
    expect.objectContaining({ code: 'AGENT_OUTDATED' }),
    expect.objectContaining({ code: 'AGENT_OUTDATED' }),
  ]);

  expect(agent.received).toEqual([]);

  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  const stream = await openOuter();

  stream.close();
  agent.close();

  expect(agent.received.map((frame) => decodeJsonPayload(frame))).toEqual([
    { op: 'exec.outer', argv: ['sh'], tty: true },
  ]);
});

test('neither the idle loop nor the governor sleeps an image builder', async () => {
  const ctx = await setupRunningImp();
  const builder = await ctx.imps.createImp({ name: 'imp-build-x', kind: 'builder' });

  const byIdle = await ctx.imps.trySleepImp(builder.id, 'idle', {
    by: 'idle',
    seenActiveAt: Date.now() + 60_000,
  });

  const byGovernor = await ctx.imps.trySleepImp(builder.id, 'budget', { by: 'governor' });

  expect([byIdle, byGovernor]).toEqual(['skipped', 'skipped']);
});

test('an imp destroyed and made again under its id, as on a move home, logs again', async () => {
  // one stack: each agent closes before the harness
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const ctx = await createImpTest(stack);

  await ctx.createTestImage('ubuntu');

  const created = await ctx.imps.createImp({ name: 'dev' });

  const id = created.id;

  const output = {
    boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
    execution_generation: 'c'.repeat(32),
    buffer_start: 0,
    end: 0,
    offset: 0,
    prelude: 0,
    log: true,
  };

  // a start creates the logged session; a tap gets STARTED and stays open
  const startAgent = async () => {
    const paths = buildImpPaths(ctx.dataDir, id);
    const identity = readVmIdentity(paths);

    if (identity === null) {
      throw new Error('no vm identity');
    }

    writeVmIdentity(paths, { ...identity, agentVersion: '0.18.0' });

    const agent = await startStubAgent(
      buildImpPaths(ctx.dataDir, id).vsockSocket,
      (socket, request, frames) => {
        if (frames.length === 1) {
          const isTap = JSON.stringify(decodeJsonPayload(request)).includes('"session.tap"');

          socket.write(
            encodeJsonFrame(FRAME_TYPES.started, {
              pid: 9,
              session: 'main',
              created: !isTap,
              output,
            }),
          );
        }
      },
    );

    stack.defer(() => {
      agent.close();
    });

    return agent;
  };

  const sessionLogsDir = buildImpPaths(ctx.dataDir, id).sessionLogsDir;
  const generationDir = `${sessionLogsDir}/${output.execution_generation}`;

  const startLogged = async () => {
    const stream = await ctx.imps.openExec(
      'dev',
      { argv: ['sh'], tty: true, session: 'main', log: true },
      'session-log',
    );

    await waitForPath(`${generationDir}/meta.json`);

    stream.close();
  };

  const first = await startAgent();

  await startLogged();

  first.close();

  await ctx.imps.destroyImp('dev');

  expect(existsSync(sessionLogsDir)).toBe(false);

  // the move home: the same id, made again
  await ctx.imps.createImp({ name: 'dev', id });

  const second = await startAgent();

  await startLogged();

  second.close();

  expect(existsSync(`${generationDir}/meta.json`)).toBe(true);

  await ctx.imps.destroyImp('dev');
});

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 2000;

  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }

    await Bun.sleep(5);
  }
}
