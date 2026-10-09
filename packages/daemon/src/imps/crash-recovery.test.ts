import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { findImpByName } from '../db/imps';
import {
  readLoadingMeta,
  readSnapshotMeta,
  setSnapshotLoading,
  writeSnapshotMeta,
} from '../sleep/snapshot-meta';
import { buildImpPaths } from '../storage/data-layout';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildTestApp, createImpTest, findBrokenInvariants } from './test-imps';
import type { ImpTestOptions } from './test-imps';

// impd killed at the points a sleep, a wake or a start can be cut, and the
// next impd's reconcile

async function setupTest(options: ImpTestOptions = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack, options);

  // the image every imp boots from
  await harness.createTestImage('ubuntu');

  return { ...harness, client: buildTestApp(harness, harness).client };
}

test('it leaves the imp stopped when impd died after a sleep renamed its files, before meta.json', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  // an earlier sleep leaves a snapshot and its meta.json behind
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  const sleeping = ctx.fake.hold('sleep');

  void ctx.client.imps.sleep({ name: 'dev' });

  await sleeping.reached;

  // the old impd's sleep writes and renames its files, then never returns
  const impd = ctx.restartImpd();

  sleeping.release();

  // the fake kills the VM, then writes and renames in the same turn
  await waitFor(() => {
    expect(ctx.fake.alive.size).toBe(0);
  });

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');
  const broken = await findBrokenInvariants(ctx, true);

  expect(existsSync(paths.vmstate)).toBeTrue();
  expect(existsSync(paths.snapshotMeta)).toBeFalse();
  expect(imp?.state).toBe('stopped');
  expect(broken).toBeEmpty();
});

test('it drops meta.json on a good wake, so a VM that dies later does not count as asleep', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  await ctx.client.imps.sleep({ name: 'dev' });

  const asleep = existsSync(paths.snapshotMeta);

  await ctx.client.imps.wake({ name: 'dev' });

  expect(asleep).toBeTrue();
  expect(existsSync(paths.snapshotMeta)).toBeFalse();
});

test('it resumes a VM a cut sleep left paused, and removes the half-written files', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);
  const sleeping = ctx.fake.hold('sleep');

  void ctx.client.imps.sleep({ name: 'dev' });

  await sleeping.reached;

  const impd = ctx.restartImpd();

  const running = await findImpByName(ctx.db, 'dev');

  invariant(running?.pid);

  // the snapshot the cut sleep was writing
  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(`${paths.vmstate}.new`, 'partial');
  writeFileSync(`${paths.memFile}.new`, 'partial');

  const paused = ctx.fake.readState(running.pid);

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(paused).toBe('Paused');
  expect(ctx.fake.readState(running.pid)).toBe('Running');
  expect(imp).toMatchObject({ state: 'running', pid: running.pid });
  expect(existsSync(`${paths.vmstate}.new`)).toBeFalse();
  expect(existsSync(`${paths.memFile}.new`)).toBeFalse();
});

test('it adopts a VM a cut wake left running with its memory', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  await ctx.client.imps.sleep({ name: 'dev' });

  // the wake loaded the snapshot; impd died before the record
  const pid = ctx.fake.spawnOrphan({ paths });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');
  const broken = await findBrokenInvariants(ctx, true);

  expect(imp).toMatchObject({ state: 'running', pid });
  expect(existsSync(paths.snapshotMeta)).toBeFalse();
  expect(broken).toBeEmpty();
});

test('it kills a VM a cut wake left before its load, and keeps the snapshot', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  await ctx.client.imps.sleep({ name: 'dev' });

  // the wake set its record aside; the load never ran the guest
  setSnapshotLoading(paths);

  const pid = ctx.fake.spawnOrphan({ paths, state: 'Not started' });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(ctx.fake.alive.has(pid)).toBeFalse();
  expect(imp?.state).toBe('sleeping');
  expect(readSnapshotMeta(paths)).not.toBeNull();
  expect(readLoadingMeta(paths)).toBeNull();
});

test('it kills a VM a cut wake left whose agent does not answer, so the imp boots cold', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  await ctx.client.imps.sleep({ name: 'dev' });

  const pid = ctx.fake.spawnOrphan({ paths });

  ctx.fake.queue('agentReady', 'fail');

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');
  const broken = await findBrokenInvariants(ctx, true);

  expect(ctx.fake.alive.has(pid)).toBeFalse();
  expect(imp?.state).toBe('stopped');
  expect(existsSync(paths.snapshotMeta)).toBeFalse();
  expect(broken).toBeEmpty();
});

test('it kills a VM a cut wake left with another agent than the snapshot recorded', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  await ctx.client.imps.sleep({ name: 'dev' });

  const meta = readSnapshotMeta(paths);

  invariant(meta);
  writeSnapshotMeta(paths, { ...meta, agentVersion: '0.0.1' });

  const pid = ctx.fake.spawnOrphan({ paths });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(ctx.fake.alive.has(pid)).toBeFalse();
  expect(imp?.state).toBe('stopped');
});

test('it kills a second VM on a running imp socket, and keeps the one on the record', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  const running = await findImpByName(ctx.db, 'dev');

  invariant(running?.pid);

  const second = ctx.fake.spawnOrphan({ paths });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(ctx.fake.alive.has(second)).toBeFalse();
  expect(ctx.fake.alive.has(running.pid)).toBeTrue();
  expect(imp).toMatchObject({ state: 'running', pid: running.pid });
});

test('it kills a VM only /proc shows after a start cut before its pid file', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  await ctx.client.imps.stop({ name: 'dev' });

  const pid = ctx.fake.spawnOrphan({ paths, pidFile: false });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(ctx.fake.alive.has(pid)).toBeFalse();
  expect(imp?.state).toBe('stopped');
});

test('it kills a VM on the socket of an imp with no record', async () => {
  const ctx = await setupTest();

  const pid = ctx.fake.spawnOrphan({ paths: buildImpPaths(ctx.dataDir, 'gone') });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  expect(ctx.fake.alive.has(pid)).toBeFalse();
});

test('it never kills a VM on a socket outside the data dir', async () => {
  const ctx = await setupTest();

  const foreign = ctx.fake.spawnOrphan({ paths: buildImpPaths('/elsewhere', 'gone') });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  expect(ctx.fake.alive.has(foreign)).toBeTrue();
});

test('it leaves the imp stopped, never on the old snapshot, after a wake cut during its load with no VM left', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  await ctx.client.imps.sleep({ name: 'dev' });

  const waking = ctx.fake.hold('wake');

  void ctx.client.imps.wake({ name: 'dev' });

  await waking.reached;

  // the load runs the guest, which may write its disk; impd dies here
  const metaMidLoad = readSnapshotMeta(paths);
  const loadingMidLoad = readLoadingMeta(paths);
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');
  const broken = await findBrokenInvariants(ctx, true);

  expect(metaMidLoad).toBeNull();
  expect(loadingMidLoad).not.toBeNull();
  expect(imp?.state).toBe('stopped');
  expect(existsSync(paths.vmstate)).toBeFalse();
  expect(broken).toBeEmpty();
});

test('it adopts the VM of a wake cut during its load that runs on, and drops its record', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  await ctx.client.imps.sleep({ name: 'dev' });

  setSnapshotLoading(paths);

  const pid = ctx.fake.spawnOrphan({ paths });

  // GET / is silent for a while, as during a large load
  ctx.fake.queue('vmState', 'fail', 'fail');

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(imp).toMatchObject({ state: 'running', pid });
  expect(readLoadingMeta(paths)).toBeNull();
  expect(readSnapshotMeta(paths)).toBeNull();
});

// A process in imp `evil`'s jail that execs `firecracker --api-sock` with
// another imp's socket: its argv says the victim, its uid and cgroup do not.

test('it ignores a VM forged on a sleeping imp socket from another jail, and keeps the snapshot', async () => {
  const ctx = await setupTest();
  const evil = await ctx.client.imps.create({ name: 'evil' });
  const created = await ctx.client.imps.create({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  await ctx.client.imps.sleep({ name: 'dev' });

  const attacker = await findImpByName(ctx.db, 'evil');

  invariant(attacker?.jailUid);

  // with no VM behind dev's socket, an adopt would find no state and drop the
  // snapshot; with the pid file pointing at it too
  const forged = ctx.fake.spawnOrphan({
    paths,
    owner: { uid: attacker.jailUid, cgroup: `/imps/${evil.id}` },
  });

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(imp?.state).toBe('sleeping');
  expect(readSnapshotMeta(paths)).not.toBeNull();
  expect(ctx.fake.alive.has(forged)).toBeTrue();
  expect(ctx.fake.stops.map((stop) => stop.pid)).not.toContain(forged);
});

test('it does not kill a VM forged on a running imp socket from another jail as its orphan', async () => {
  const ctx = await setupTest();
  const evil = await ctx.client.imps.create({ name: 'evil' });
  const created = await ctx.client.imps.create({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  const attacker = await findImpByName(ctx.db, 'evil');
  const running = await findImpByName(ctx.db, 'dev');

  invariant(attacker?.jailUid);
  invariant(running?.pid);

  const forged = ctx.fake.spawnOrphan({
    paths,
    owner: { uid: attacker.jailUid, cgroup: `/imps/${evil.id}` },
  });

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(imp).toMatchObject({ state: 'running', pid: running.pid });
  expect(ctx.fake.alive.has(running.pid)).toBeTrue();
  expect(ctx.fake.stops).toBeEmpty();
  expect(ctx.fake.alive.has(forged)).toBeTrue();
});

test('it adopts a jailed VM a cut wake left by its own uid', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  await ctx.client.imps.sleep({ name: 'dev' });

  const dev = await findImpByName(ctx.db, 'dev');

  invariant(dev?.jailUid);

  const byUid = ctx.fake.spawnOrphan({ paths, owner: { uid: dev.jailUid, cgroup: '/init' } });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const adopted = await findImpByName(ctx.db, 'dev');

  expect(adopted).toMatchObject({ state: 'running', pid: byUid });
});

test('it adopts a jailed VM a cut wake left by its own cgroup', async () => {
  const ctx = await setupTest();
  const created = await ctx.client.imps.create({ name: 'box' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  await ctx.client.imps.sleep({ name: 'box' });

  const byCgroup = ctx.fake.spawnOrphan({
    paths,
    owner: { uid: null, cgroup: `/imps/${created.id}` },
  });

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const adopted = await findImpByName(ctx.db, 'box');

  expect(adopted).toMatchObject({ state: 'running', pid: byCgroup });
});

test('it does not kill a VM forged from another jail on the socket of an imp with no record', async () => {
  const ctx = await setupTest();
  const evil = await ctx.client.imps.create({ name: 'evil' });
  const attacker = await findImpByName(ctx.db, 'evil');

  invariant(attacker?.jailUid);

  const forged = ctx.fake.spawnOrphan({
    paths: buildImpPaths(ctx.dataDir, 'gone'),
    owner: { uid: attacker.jailUid, cgroup: `/imps/${evil.id}` },
  });

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  expect(ctx.fake.alive.has(forged)).toBeTrue();
});

test('it kills a VM in the cgroup of an imp with no record', async () => {
  const ctx = await setupTest();

  const jailed = ctx.fake.spawnOrphan({
    paths: buildImpPaths(ctx.dataDir, 'gone'),
    owner: { uid: 900_123, cgroup: '/imps/gone' },
  });

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  expect(ctx.fake.alive.has(jailed)).toBeFalse();
});

test('it stops an imp whose recycled pid another jail forged, never re-adopting it into the cgroup', async () => {
  const ctx = await setupTest();
  const evil = await ctx.client.imps.create({ name: 'evil' });

  await ctx.client.imps.create({ name: 'dev' });

  const attacker = await findImpByName(ctx.db, 'evil');
  const running = await findImpByName(ctx.db, 'dev');

  invariant(attacker?.jailUid);
  invariant(running?.pid);

  // dev's VM died while impd was down, and evil's jail got its pid
  ctx.fake.setOwner(running.pid, { uid: attacker.jailUid, cgroup: `/imps/${evil.id}` });

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(imp).toMatchObject({ state: 'stopped', pid: null });
});

test('it removes the orphan jails before the orphan cgroups, so a cut-short build leaves its cgroup empty', async () => {
  const stub = buildStubCpuCgroups();

  // the fake's sweep record, which the cgroups sweep joins once impd is up
  const order: { sweeps: string[] } = { sweeps: [] };

  const ctx = await setupTest({
    cgroups: {
      ...stub.cgroups,
      removeOrphans: (impIds) => {
        order.sweeps.push('cgroups');

        return stub.cgroups.removeOrphans(impIds);
      },
    },
  });

  order.sweeps = ctx.fake.sweeps;

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  expect(ctx.fake.sweeps).toStrictEqual(['jails', 'cgroups']);
});
