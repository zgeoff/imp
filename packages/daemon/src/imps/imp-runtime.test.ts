import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { FRAME_TYPES, decodeJsonPayload, encodeJsonFrame } from '../agent-client/frame-codec';
import { findImpByName, updateImpActivity } from '../db/imps';
import { writeLease } from '../db/leases';
import { readVmIdentity, writeVmIdentity } from '../sleep/vm-identity';
import { buildImpPaths } from '../storage/data-layout';
import { buildMockLeaseRecord } from '../test-utils/build-mock-lease-record';
import { buildStubMounts } from '../test-utils/build-stub-mounts';
import { buildStubUidProcesses } from '../test-utils/build-stub-uid-processes';
import { startStubAgent } from '../test-utils/start-stub-agent';
import { startStubInnerAgent } from '../test-utils/start-stub-inner-agent';
import { startStubSessionAgent } from '../test-utils/start-stub-session-agent';
import { createJails } from '../vmm/jail';
import { createImpTest, waitForOutcome } from './test-imps';
import type { ImpTestOptions } from './test-imps';

// `installBundle`: the broker's CA install in the guest, which a test fails
// or holds
async function setupTest(
  options: Pick<ImpTestOptions, 'env' | 'frozenClockMs' | 'installBundle'> = {},
) {
  // one stack: an agent a test starts closes before the harness
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const chrootBase = mkdtempSync(join(tmpdir(), 'imp-runtime-jail-'));

  stack.defer(() => {
    rmSync(chrootBase, { recursive: true, force: true });
  });

  // the real jailer over the host's processes and mounts, so a stopped VM's
  // jail goes as on a host
  const processes = buildStubUidProcesses();
  const mounts = buildStubMounts();

  const jails = createJails({
    jailerBin: 'jailer',
    firecrackerBin: '/usr/local/bin/firecracker',
    chrootBase,
    run: mounts.run,
    readMounts: mounts.readMounts,
    log: () => {},
    ...processes.deps,
  });

  const harness = await createImpTest(stack, { ...options, jails });

  // every imp boots from an image row
  await harness.createTestImage('ubuntu');

  return { ...harness, stack, chrootBase, processes };
}

test('it skips an idle sleep of an imp held after the idle loop looked', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const until = new Date(ctx.now() + 60_000);

  await writeLease(ctx.db, buildMockLeaseRecord({ impId: imp.id, until }), {
    at: ctx.now(),
    reason: 'held',
  });

  const outcome = await ctx.imps.trySleepImp(imp.id, 'idle', {
    by: 'idle',
    seenActiveAt: imp.lastActiveAt.getTime(),
  });

  expect(outcome).toBe('skipped');
});

test('it skips a governor sleep of an imp held after the governor looked', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const until = new Date(ctx.now() + 60_000);

  await writeLease(ctx.db, buildMockLeaseRecord({ impId: imp.id, until }), {
    at: ctx.now(),
    reason: 'held',
  });

  const outcome = await ctx.imps.trySleepImp(imp.id, 'budget', { by: 'governor' });

  expect(outcome).toBe('skipped');
});

test('it skips an idle sleep of an imp active since the idle loop looked', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const seenActiveAt = imp.lastActiveAt.getTime();

  await updateImpActivity(ctx.db, imp.id, new Date(seenActiveAt + 1000));

  const outcome = await ctx.imps.trySleepImp(imp.id, 'idle', { by: 'idle', seenActiveAt });

  expect(outcome).toBe('skipped');
});

test('it sleeps an imp for the governor however recently it was active', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  await updateImpActivity(ctx.db, imp.id, new Date(imp.lastActiveAt.getTime() + 1000));

  const outcome = await ctx.imps.trySleepImp(imp.id, 'budget', { by: 'governor' });

  expect(outcome).toBe('slept');
});

test('it skips a background sleep of an imp with an open connection', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const release = ctx.imps.tracker.open(imp.id, 'proxy');

  onTestFinished(release);

  const outcome = await ctx.imps.trySleepImp(imp.id, 'budget', { by: 'governor' });

  expect(outcome).toBe('skipped');
});

test('it skips a background sleep of an imp whose lock is taken', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const gate = Promise.withResolvers<void>();

  // the lock goes back even when the act throws
  onTestFinished(() => {
    gate.resolve();
  });

  const holding = ctx.imps.lockImp('dev', () => gate.promise);

  await waitFor(() => {
    expect(ctx.imps.isImpBusy(imp.id)).toBeTrue();
  });

  const outcome = await ctx.imps.trySleepImp(imp.id, 'budget', { by: 'governor' });

  gate.resolve();

  await holding;

  expect(outcome).toBe('skipped');
});

test('it waits for a young guest to reach the minimum uptime before it sleeps it', async () => {
  // a frozen clock: only the wait's own pauses move it
  const ctx = await setupTest({
    env: { IMP_SLEEP_MIN_GUEST_UPTIME_MS: '300' },
    frozenClockMs: Date.parse('2026-10-09T12:00:00Z'),
  });

  await ctx.imps.createImp({ name: 'dev' });

  // 100 ms old against a 300 ms minimum: the wait lasts 200 ms
  ctx.fake.setGuestUptime(100);

  const asleep = await ctx.imps.sleepImp('dev');

  const waitedMs = ctx.logs
    .map((line) => /waited (?<ms>\d+)ms for a young guest/u.exec(line)?.groups?.['ms'])
    .find((ms) => ms !== undefined);

  expect(asleep.state).toBe('sleeping');
  expect(waitedMs).toBe('200');
});

// the guest needs ten minutes more, so only a give-way ends the wait within
// the 2 s bound
test('it gives way to a request while an idle sleep waits for a young guest', async () => {
  const ctx = await setupTest({ env: { IMP_SLEEP_MIN_GUEST_UPTIME_MS: '600000' } });
  const imp = await ctx.imps.createImp({ name: 'dev' });

  ctx.fake.setGuestUptime(0);

  const sleeping = ctx.imps.trySleepImp(imp.id, 'idle', {
    by: 'idle',
    seenActiveAt: imp.lastActiveAt.getTime(),
  });

  await waitFor(() => {
    expect(ctx.imps.isWaitingForYoungGuest(imp.id)).toBeTrue();
  });

  // as the wake proxy does: the connection counts before it waits for the lock
  const opened = { release: () => {} };

  onTestFinished(() => {
    opened.release();
  });

  const request = ctx.imps.requireRunning('dev', (found) => {
    opened.release = ctx.imps.tracker.open(found.id, 'proxy');
  });

  const settled = await waitForOutcome(sleeping, 2000);
  const outcome = await sleeping;
  const running = await request;

  expect(settled).toBe('done');
  expect(outcome).toBe('skipped');
  expect(running.imp.state).toBe('running');
  expect(running.wokeMs).toBeNull();
  expect(ctx.logs).toContain('impd: dev: sleep (idle) gave way: the imp turned busy');
});

// the guest needs ten minutes more, so only a give-way ends the wait within
// the 2 s bound
test('it gives way to a hold while an idle sleep waits for a young guest', async () => {
  const ctx = await setupTest({ env: { IMP_SLEEP_MIN_GUEST_UPTIME_MS: '600000' } });
  const imp = await ctx.imps.createImp({ name: 'dev' });

  ctx.fake.setGuestUptime(0);

  const sleeping = ctx.imps.trySleepImp(imp.id, 'idle', {
    by: 'idle',
    seenActiveAt: imp.lastActiveAt.getTime(),
  });

  await waitFor(() => {
    expect(ctx.imps.isWaitingForYoungGuest(imp.id)).toBeTrue();
  });

  const until = new Date(ctx.now() + 60_000);

  await writeLease(ctx.db, buildMockLeaseRecord({ impId: imp.id, until }), {
    at: ctx.now(),
    reason: 'held',
  });

  const settled = await waitForOutcome(sleeping, 2000);
  const outcome = await sleeping;
  const after = await findImpByName(ctx.db, 'dev');

  expect(settled).toBe('done');
  expect(outcome).toBe('skipped');
  expect(after?.state).toBe('running');
  expect(ctx.logs).toContain('impd: dev: sleep (idle) gave way: the imp turned busy');
});

// the guests need ten minutes more, so a governor that waited for them would
// not admit the boot within the 2 s bound
test('it sleeps young guests at once when the governor makes room for a boot', async () => {
  // three imps own 300 MiB each; a 720 MiB boot needs all three asleep
  const ctx = await setupTest({
    env: {
      IMP_RAM_BUDGET_MIB: '1000',
      IMP_DEFAULT_MEMORY_MIB: '256',
      IMP_BOOT_RESERVE_PERCENT: '100',
      IMP_SLEEP_MIN_GUEST_UPTIME_MS: '600000',
    },
  });

  await ctx.imps.createImp({ name: 'a' });
  await ctx.imps.createImp({ name: 'b' });
  await ctx.imps.createImp({ name: 'c' });

  ctx.fake.setGuestUptime(0);

  const admitted = await waitForOutcome(ctx.imps.createImp({ name: 'big', memoryMib: 720 }), 2000);
  const imps = await ctx.imps.listImps();

  expect(admitted).toBe('done');

  expect(imps.map((imp) => [imp.name, imp.state])).toStrictEqual([
    ['a', 'sleeping'],
    ['b', 'sleeping'],
    ['big', 'running'],
    ['c', 'sleeping'],
  ]);

  expect(ctx.logs).not.toSatisfyAny((line: string) => line.includes('for a young guest'));
});

test('it sleeps held and connected imps when impd stops', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const until = new Date(ctx.now() + 60_000);

  await writeLease(ctx.db, buildMockLeaseRecord({ impId: imp.id, until }), {
    at: ctx.now(),
    reason: 'held',
  });

  const release = ctx.imps.tracker.open(imp.id, 'exec');

  onTestFinished(release);

  await ctx.imps.sleepAllImps();

  const after = await findImpByName(ctx.db, 'dev');

  expect(after?.state).toBe('sleeping');
});

test('it counts an exec before its wake and drops it when the wake fails', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.stopImp('dev');

  const gate = ctx.fake.hold('boot');

  ctx.fake.queue('boot', 'fail');

  const exec = ctx.imps.openExec('dev', { argv: ['true'], tty: false });

  await gate.reached;

  const during = ctx.imps.tracker.count(imp.id, 'exec');

  gate.release();

  expect(exec).rejects.toThrow('boot failed');
  expect(during).toBe(1);
  expect(ctx.imps.tracker.count(imp.id)).toBe(0);
});

test('it counts a tunnel as a tunnel, not an exec, from before its wake', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.stopImp('dev');

  const gate = ctx.fake.hold('boot');

  ctx.fake.queue('boot', 'fail');

  const dial = ctx.imps.openDial('dev', { network: 'tcp', address: '127.0.0.1:5432' }, 'tunnel');

  await gate.reached;

  const tunnels = ctx.imps.tracker.count(imp.id, 'tunnel');
  const execs = ctx.imps.tracker.count(imp.id, 'exec');

  gate.release();

  expect(dial).rejects.toThrow('boot failed');
  expect(tunnels).toBe(1);
  expect(execs).toBe(0);
  expect(ctx.imps.tracker.count(imp.id)).toBe(0);
});

test('it waits for a boot under way and sleeps that imp when impd stops', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.stopImp('dev');

  const gate = ctx.fake.hold('boot');
  const starting = ctx.imps.startImp('dev');

  await gate.reached;

  const stopping = ctx.imps.sleepAllImps();

  await waitFor(() => {
    expect(ctx.imps.countLockQueue(imp.id)).toBe(2);
  });

  gate.release();

  await Promise.all([starting, stopping]);

  const after = await findImpByName(ctx.db, 'dev');

  expect(after?.state).toBe('sleeping');
});

test('it refuses a boot once impd is stopping', async () => {
  const ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.imps.stopImp('dev');
  await ctx.imps.sleepAllImps();

  expect(ctx.imps.startImp('dev')).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
    message: 'impd is stopping',
  });
});

// a pass that hung, or a stop that waited on it forever, reports hung after
// 10 s; the 30 s test timeout leaves room for both bounded waits
test('it neither hangs nor wakes anything when a governor pass meets impd stopping', async () => {
  const ctx = await setupTest({
    env: { IMP_RAM_BUDGET_MIB: '500', IMP_DEFAULT_MEMORY_MIB: '256' },
  });

  await ctx.imps.createImp({ name: 'a' });
  await ctx.imps.createImp({ name: 'b' });

  const gate = ctx.fake.hold('sleep');

  // 600 MiB awake against a budget of 500: the pass wants one asleep
  const enforcing = ctx.governor.enforce();
  const stopping = ctx.imps.sleepAllImps();

  await gate.reached;

  gate.release();

  const enforced = await waitForOutcome(enforcing, 10_000);
  const stopped = await waitForOutcome(stopping, 10_000);
  const imps = await ctx.imps.listImps();

  expect(enforced).toBe('done');
  expect(stopped).toBe('done');
  expect(imps.map((imp) => imp.state)).toStrictEqual(['sleeping', 'sleeping']);
}, 30_000);

test('it refuses a create that impd stopping cuts short, and records it as an error', async () => {
  const ctx = await setupTest();

  await ctx.imps.sleepAllImps();

  expect(ctx.imps.createImp({ name: 'late' })).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
  });

  const late = await findImpByName(ctx.db, 'late');

  expect(late).toMatchObject({ state: 'error', error: 'impd is stopping' });
});

test('it removes the imp once a create under way when its destroy was issued has booted', async () => {
  const ctx = await setupTest();

  const gate = ctx.fake.hold('boot');
  const creating = ctx.imps.createImp({ name: 'dev' });

  await gate.reached;

  const found = await findImpByName(ctx.db, 'dev');

  invariant(found);

  const destroying = ctx.imps.destroyImp('dev');

  await waitFor(() => {
    expect(ctx.imps.countLockQueue(found.id)).toBe(2);
  });

  gate.release();

  const created = await creating;

  await destroying;

  const left = await findImpByName(ctx.db, 'dev');

  expect(created.state).toBe('running');
  expect(left).toBeUndefined();
  expect(ctx.fake.alive.size).toBe(0);
});

test('it removes a running imp whose VM takes long to exit on the first call', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  ctx.processes.ownRoot(join(ctx.chrootBase, 'firecracker', imp.id, 'root'), 900_001);
  ctx.processes.start(900_001, 4242);

  // as Firecracker frees many GiB of guest memory: past the scans in which a
  // process that still runs counts as surviving its kills
  ctx.processes.exitSlowly(4242, 200);

  await ctx.imps.destroyImp('dev');

  const left = await findImpByName(ctx.db, 'dev');

  expect(left).toBeUndefined();
});

test('it lists the imps while a removal waits for its VM to exit', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  ctx.processes.ownRoot(join(ctx.chrootBase, 'firecracker', imp.id, 'root'), 900_001);
  ctx.processes.start(900_001, 4242);
  ctx.processes.exitSlowly(4242, 200);

  // past the scans in which a process that still runs counts as surviving
  const pause = ctx.processes.holdPause(100);
  const removing = ctx.imps.destroyImp('dev');

  await Promise.race([pause.reached, removing]);

  const listed = await ctx.imps.listImps();

  // the removal ends before the harness closes the database under it
  pause.release();

  await removing;

  expect(listed).toPartiallyContain({ name: 'dev', state: 'running' });
});

test('it refuses a session exec on an agent from before sessions before it connects', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  // an agent that listens, so a connection the refusal let through shows
  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket) => {
      socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
    },
    { stack: ctx.stack },
  );

  expect(
    ctx.imps.openExec('dev', { argv: ['sh'], tty: true, session: 'main' }),
  ).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });

  expect(agent.received).toBeEmpty();
  expect(ctx.imps.tracker.count(imp.id)).toBe(0);
});

test('it refuses a unix socket dial on an agent from before 0.6.0', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.5.0' });

  expect(
    ctx.imps.openDial('dev', { network: 'unix', address: '/run/docker.sock' }, 'ssh'),
  ).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
});

test('it sends a tcp dial to an agent from before 0.6.0', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.5.0' });

  const agent = await startStubAgent(
    paths.vsockSocket,
    (socket) => {
      socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
    },
    { stack: ctx.stack },
  );

  const stream = await ctx.imps.openDial('dev', { network: 'tcp', address: '127.0.0.1:80' }, 'ssh');

  stream.close();

  expect(agent.received.map((frame) => decodeJsonPayload(frame))).toStrictEqual([
    { op: 'dial', network: 'tcp', address: '127.0.0.1:80' },
  ]);
});

test('it refuses an outer exec to an imp with no agent version on record', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubAgent(
    paths.vsockSocket,
    (socket) => {
      socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 9 }));
    },
    { stack: ctx.stack },
  );

  // an imp booted before impd recorded versions has no identity file
  rmSync(paths.vmIdentity);

  const opening = ctx.imps.openExec('dev', { argv: ['sh'], tty: true, outer: true }, 'outer-exec');

  expect(opening).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
  expect(opening).rejects.toThrow("impd has no record of the imp's agent version");
  expect(agent.received).toBeEmpty();
});

test.each([
  ['a version that does not parse', 'dev'],
  ['a version from before outer exec', '0.15.0'],
])('it refuses an outer exec to an agent with %s', async (_label, agentVersion) => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion });

  const agent = await startStubAgent(
    paths.vsockSocket,
    (socket) => {
      socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 9 }));
    },
    { stack: ctx.stack },
  );

  expect(
    ctx.imps.openExec('dev', { argv: ['sh'], tty: true, outer: true }, 'outer-exec'),
  ).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });

  expect(agent.received).toBeEmpty();
});

test('it sends an outer exec to an agent from 0.16.0', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  const agent = await startStubAgent(
    paths.vsockSocket,
    (socket) => {
      socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 9 }));
    },
    { stack: ctx.stack },
  );

  const stream = await ctx.imps.openExec(
    'dev',
    { argv: ['sh'], tty: true, outer: true },
    'outer-exec',
  );

  stream.close();

  expect(agent.received.map((frame) => decodeJsonPayload(frame))).toStrictEqual([
    { op: 'exec.outer', argv: ['sh'], tty: true },
  ]);
});

test('it never idle-sleeps an image builder', async () => {
  const ctx = await setupTest();
  const builder = await ctx.imps.createImp({ name: 'imp-build-x', kind: 'builder' });

  const outcome = await ctx.imps.trySleepImp(builder.id, 'idle', {
    by: 'idle',
    seenActiveAt: ctx.now() + 60_000,
  });

  expect(outcome).toBe('skipped');
});

test('it never sleeps an image builder for the governor', async () => {
  const ctx = await setupTest();
  const builder = await ctx.imps.createImp({ name: 'imp-build-x', kind: 'builder' });
  const outcome = await ctx.imps.trySleepImp(builder.id, 'budget', { by: 'governor' });

  expect(outcome).toBe('skipped');
});

test('it refuses a dial into an image builder', async () => {
  const ctx = await setupTest();

  await ctx.imps.createImp({ name: 'imp-build-x', kind: 'builder' });

  expect(
    ctx.imps.openDial('imp-build-x', { network: 'tcp', address: '127.0.0.1:80' }, 'ssh'),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('it refuses an attach without a wake to an image builder', async () => {
  const ctx = await setupTest();

  await ctx.imps.createImp({ name: 'imp-build-x', kind: 'builder' });

  expect(
    ctx.imps.openAttach('imp-build-x', { session: 'main', wake: false }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('it refuses to find the agent of an image builder', async () => {
  const ctx = await setupTest();

  await ctx.imps.createImp({ name: 'imp-build-x', kind: 'builder' });

  expect(ctx.imps.findAgent('imp-build-x')).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test("it removes an imp's session logs when the imp is destroyed", async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.18.0' });

  // the start creates the logged session; the tap impd opens gets STARTED for
  // the session it found, and stays open
  await startStubAgent(
    paths.vsockSocket,
    (socket, request, frames) => {
      if (frames.length !== 1) {
        return;
      }

      const isTap = JSON.stringify(decodeJsonPayload(request)).includes('"session.tap"');

      socket.write(
        encodeJsonFrame(FRAME_TYPES.started, {
          pid: 9,
          session: 'main',
          created: !isTap,
          output: {
            boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
            execution_generation: 'c'.repeat(32),
            buffer_start: 0,
            end: 0,
            offset: 0,
            prelude: 0,
            log: true,
          },
        }),
      );
    },
    { stack: ctx.stack },
  );

  const stream = await ctx.imps.openExec(
    'dev',
    { argv: ['sh'], tty: true, session: 'main', log: true },
    'session-log',
  );

  await waitFor(() => {
    expect(existsSync(`${paths.sessionLogsDir}/${'c'.repeat(32)}/meta.json`)).toBeTrue();
  });

  stream.close();

  await ctx.imps.destroyImp('dev');

  expect(existsSync(paths.sessionLogsDir)).toBeFalse();
});

test('it logs again for an imp made again under the id of one destroyed, as on a move home', async () => {
  const ctx = await setupTest();
  const first = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, first.id);
  const firstIdentity = readVmIdentity(paths);

  invariant(firstIdentity);
  writeVmIdentity(paths, { ...firstIdentity, agentVersion: '0.18.0' });

  // the start creates the logged session; the tap impd opens gets STARTED for
  // the session it found, and stays open
  const firstAgent = await startStubAgent(
    paths.vsockSocket,
    (socket, request, frames) => {
      if (frames.length !== 1) {
        return;
      }

      const isTap = JSON.stringify(decodeJsonPayload(request)).includes('"session.tap"');

      socket.write(
        encodeJsonFrame(FRAME_TYPES.started, {
          pid: 9,
          session: 'main',
          created: !isTap,
          output: {
            boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
            execution_generation: 'c'.repeat(32),
            buffer_start: 0,
            end: 0,
            offset: 0,
            prelude: 0,
            log: true,
          },
        }),
      );
    },
    { stack: ctx.stack },
  );

  const firstStream = await ctx.imps.openExec(
    'dev',
    { argv: ['sh'], tty: true, session: 'main', log: true },
    'session-log',
  );

  await waitFor(() => {
    expect(existsSync(`${paths.sessionLogsDir}/${'c'.repeat(32)}/meta.json`)).toBeTrue();
  });

  firstStream.close();
  firstAgent.close();

  await ctx.imps.destroyImp('dev');
  await ctx.imps.createImp({ name: 'dev', id: first.id });

  const secondIdentity = readVmIdentity(paths);

  invariant(secondIdentity);
  writeVmIdentity(paths, { ...secondIdentity, agentVersion: '0.18.0' });

  // the agent of the imp made again answers as the first did
  await startStubAgent(
    paths.vsockSocket,
    (socket, request, frames) => {
      if (frames.length !== 1) {
        return;
      }

      const isTap = JSON.stringify(decodeJsonPayload(request)).includes('"session.tap"');

      socket.write(
        encodeJsonFrame(FRAME_TYPES.started, {
          pid: 9,
          session: 'main',
          created: !isTap,
          output: {
            boot_id: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
            execution_generation: 'c'.repeat(32),
            buffer_start: 0,
            end: 0,
            offset: 0,
            prelude: 0,
            log: true,
          },
        }),
      );
    },
    { stack: ctx.stack },
  );

  const stream = await ctx.imps.openExec(
    'dev',
    { argv: ['sh'], tty: true, session: 'main', log: true },
    'session-log',
  );

  onTestFinished(stream.close);

  await waitFor(() => {
    expect(existsSync(`${paths.sessionLogsDir}/${'c'.repeat(32)}/meta.json`)).toBeTrue();
  });
});

test('it shows the inner container of an awake imp as its agent last reported it', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  await startStubInnerAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    inner: { up: false, restarts: 3, lastError: 'start inner init: exit status 1' },
    stack: ctx.stack,
  });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  await ctx.imps.readActivity(record);

  const shown = await ctx.imps.toApi(record);

  expect(shown.inner).toStrictEqual({
    up: false,
    restarts: 3,
    lastError: 'start inner init: exit status 1',
  });
});

test('it shows no inner container once the agent stops answering', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubInnerAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    inner: { up: false, restarts: 3 },
    stack: ctx.stack,
  });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  await ctx.imps.readActivity(record);

  agent.close();

  const answer = await ctx.imps.readActivity(record);
  const shown = await ctx.imps.toApi(record);

  expect(answer).toBeNull();
  expect(shown).not.toContainKey('inner');
});

test('it shows no inner container from before a sleep once the imp wakes', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubInnerAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    inner: { up: false, restarts: 3 },
    stack: ctx.stack,
  });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  await ctx.imps.readActivity(record);

  // the sleep and the wake ask the agent nothing it answers
  agent.close();

  await ctx.imps.sleepImp('dev');

  const awake = await ctx.imps.wakeImp('dev');

  expect(awake.state).toBe('running');
  expect(awake).not.toContainKey('inner');
});

test('it shows no inner container for an agent from before 0.14.0', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, request) => {
      const isPing = JSON.stringify(decodeJsonPayload(request)).includes('"ping"');

      const answer = isPing
        ? { ok: true, version: '0.13.0' }
        : { tcp_established: 0, exec_sessions: 0, load1: 0 };

      socket.end(encodeJsonFrame(FRAME_TYPES.response, answer));
    },
    { stack: ctx.stack },
  );

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  await ctx.imps.readActivity(record);

  const shown = await ctx.imps.toApi(record);

  expect(shown).not.toContainKey('inner');
});

test('it refuses an exec that requires the broker without a grant', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  expect(
    ctx.imps.openExec('dev', { argv: ['true'], tty: false, require: ['broker'] }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: 'the imp has no grant, so impd sets no broker variables',
    },
  });

  expect(agent.readExecs()).toBeEmpty();
});

test('it runs an exec without the requirement on an imp with no grant', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  const stream = await ctx.imps.openExec('dev', { argv: ['true'], tty: false });

  stream.close();

  expect(agent.readExecs()).toHaveLength(1);
});

test('it refuses the exec when the CA bundle step fails', async () => {
  const ctx = await setupTest({ installBundle: () => Promise.reject(new Error('no /bin/sh')) });
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  expect(
    ctx.imps.openExec('dev', { argv: ['true'], tty: false, require: ['broker'] }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: 'the broker CA bundle is not in this boot of the guest: no /bin/sh',
    },
  });

  expect(agent.readExecs()).toBeEmpty();
});

test('it tries the CA bundle step again at the next exec after one failed', async () => {
  const install = { fail: true };

  const ctx = await setupTest({
    installBundle: () =>
      install.fail ? Promise.reject(new Error('no /bin/sh')) : Promise.resolve(),
  });

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const failed = await ctx.imps
    .openExec('dev', { argv: ['true'], tty: false, require: ['broker'] })
    .then(
      () => null,
      (error: unknown) => error,
    );

  install.fail = false;

  const stream = await ctx.imps.openExec('dev', {
    argv: ['true'],
    tty: false,
    require: ['broker'],
  });

  stream.close();

  expect(failed).toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: 'the broker CA bundle is not in this boot of the guest: no /bin/sh',
    },
  });

  expect(agent.readExecs()).toHaveLength(1);
  expect(agent.readExecs()[0]?.env).toContain('HTTPS_PROXY=http://10.66.0.1:7081');
});

test('it never sends the requirement to the agent', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const stream = await ctx.imps.openExec('dev', {
    argv: ['true'],
    tty: false,
    require: ['broker'],
  });

  stream.close();

  const [sent] = agent.readExecPayloads();

  invariant(sent);

  expect(sent).not.toHaveProperty('require');
});

test('it runs the CA bundle step before the first exec of a boot, with the broker variables', async () => {
  // how many execs the agent had got at each CA bundle step
  const sentAtInstall: number[] = [];
  const agentRef: { readExecs: () => readonly unknown[] } = { readExecs: () => [] };

  const ctx = await setupTest({
    installBundle: () => {
      sentAtInstall.push(agentRef.readExecs().length);

      return Promise.resolve();
    },
  });

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  agentRef.readExecs = agent.readExecs;

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const stream = await ctx.imps.openExec('dev', {
    argv: ['true'],
    tty: false,
    require: ['broker'],
  });

  stream.close();

  const env = agent.readExecs()[0]?.env;

  expect(sentAtInstall).toStrictEqual([0]);
  expect(agent.readExecs()).toHaveLength(1);
  expect(env).toContain('HTTPS_PROXY=http://10.66.0.1:7081');
  expect(env).toContain('SSL_CERT_FILE=/etc/imp/broker-ca.pem');
});

test('it runs the CA bundle step again after a reboot', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const first = await ctx.imps.openExec('dev', { argv: ['true'], tty: false, require: ['broker'] });

  first.close();

  // a restore halts the guest and boots it again: a new boot
  await ctx.imps.lockImp('dev', async (locked) => {
    const halted = await ctx.imps.haltImp(locked, false);

    await ctx.imps.bootImp(halted);
  });

  const second = await ctx.imps.openExec('dev', {
    argv: ['true'],
    tty: false,
    require: ['broker'],
  });

  second.close();

  expect(ctx.bundleInstalls).toHaveLength(2);
});

test('it refuses an env that replaces a broker variable, and names it', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  expect(
    ctx.imps.openExec('dev', {
      argv: ['true'],
      tty: false,
      require: ['broker'],
      env: ['SSL_CERT_FILE=/tmp/mine.pem'],
    }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: "the exec's env sets SSL_CERT_FILE, which the broker sets",
    },
  });

  expect(agent.readExecs()).toBeEmpty();
});

test('it passes an env variable the broker does not set', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const stream = await ctx.imps.openExec('dev', {
    argv: ['true'],
    tty: false,
    require: ['broker'],
    env: ['TERM=xterm'],
  });

  stream.close();

  expect(agent.readExecs()[0]?.env).toContain('TERM=xterm');
});

test('it refuses the broker requirement for an outer exec', async () => {
  const ctx = await setupTest();
  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  expect(
    ctx.imps.openExec(
      'dev',
      { argv: ['true'], tty: false, require: ['broker'], outer: true },
      'outer-exec',
    ),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: { reason: 'broker_not_ready', detail: 'an exec in the agent gets no broker variables' },
  });

  expect(agent.readExecs()).toBeEmpty();
});

test('it runs no lifecycle operation between the CA bundle step and the start', async () => {
  const install = { release: () => {}, reached: () => {} };

  const reached = new Promise<void>((resolve) => {
    install.reached = resolve;
  });

  const ctx = await setupTest({
    installBundle: () =>
      new Promise<void>((resolve) => {
        install.release = resolve;

        install.reached();
      }),
  });

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const order: string[] = [];

  const exec = (async () => {
    const stream = await ctx.imps.openExec('dev', {
      argv: ['true'],
      tty: false,
      require: ['broker'],
    });

    order.push(`exec started (${String(agent.readExecs().length)} sent)`);
    stream.close();
  })();

  await reached;

  // as a restore would: it queues on the lock the exec holds
  const locked = ctx.imps.lockImp('dev', () => {
    order.push('lifecycle');

    return Promise.resolve();
  });

  await waitFor(() => {
    expect(ctx.imps.countLockQueue(imp.id)).toBe(2);
  });

  const beforeRelease = [...order];

  install.release();

  await Promise.all([exec, locked]);

  expect(beforeRelease).toBeEmpty();
  expect(order).toStrictEqual(['exec started (1 sent)', 'lifecycle']);
});

test('it boots the imp again and checks again when a stop takes the lock before the exec', async () => {
  const order: string[] = [];

  const ctx = await setupTest({
    installBundle: () => {
      order.push('bundle');

      return Promise.resolve();
    },
  });

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  // the stop holds the lock until the exec queues behind it, so the exec
  // found the imp running and its bundle step waits for the stop
  const stopGate = Promise.withResolvers<void>();

  onTestFinished(() => {
    stopGate.resolve();
  });

  const stopping = ctx.imps.lockImp('dev', async (locked) => {
    await stopGate.promise;

    await ctx.imps.haltImp(locked, false);

    order.push('stopped');
  });

  const opening = ctx.imps.openExec('dev', { argv: ['true'], tty: false, require: ['broker'] });

  await waitFor(() => {
    expect(ctx.imps.countLockQueue(imp.id)).toBe(2);
  });

  const bootsBefore = ctx.fake.boots.length;

  stopGate.resolve();

  const stream = await opening;

  stream.close();

  await stopping;

  expect(order).toStrictEqual(['stopped', 'bundle']);
  expect(ctx.fake.boots).toHaveLength(bootsBefore + 1);
  expect(agent.readExecs()[0]?.env).toContain('HTTPS_PROXY=http://10.66.0.1:7081');
});
