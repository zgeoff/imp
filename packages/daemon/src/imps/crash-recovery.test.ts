import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { findImpByName } from '../db/imps';
import {
  readLoadingMeta,
  readSnapshotMeta,
  setSnapshotLoading,
  writeSnapshotMeta,
} from '../sleep/snapshot-meta';
import { buildImpPaths } from '../storage/data-layout';
import type { CpuCgroups } from '../vmm/cpu-cgroups';
import { buildTestApp, findBrokenInvariants, setupImpTest } from './test-imps';

// impd killed at the points a sleep, a wake or a start can be cut, and the
// next impd's reconcile

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }

    await Bun.sleep(1);
  }
}

async function setupCrashTest() {
  const ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');

  const findPaths = async (name: string) => {
    const imp = await findImpByName(ctx.db, name);

    return buildImpPaths(ctx.dataDir, imp?.id ?? '');
  };

  return { ...ctx, client: buildTestApp(ctx, ctx).client, findPaths };
}

test('impd killed after a sleep renamed its files, before meta.json, leaves the imp stopped', async () => {
  const ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });

  // an earlier sleep leaves a snapshot and its meta.json behind
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  const sleeping = ctx.fake.hold('sleep');

  void ctx.client.imps.sleep({ name: 'dev' });

  await sleeping.reached;

  // the old impd's sleep writes and renames its files, then never returns
  const impd = ctx.restartImpd();

  sleeping.release();

  const paths = await ctx.findPaths('dev');

  // the fake kills the VM, then writes and renames in the same turn
  await waitUntil(() => ctx.fake.alive.size === 0);

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');
  const broken = await findBrokenInvariants(ctx, true);

  expect(existsSync(paths.vmstate)).toBeTrue();
  expect(existsSync(paths.snapshotMeta)).toBeFalse();
  expect(imp?.state).toBe('stopped');
  expect(broken).toEqual([]);
});

test('a good wake drops meta.json, so a VM that dies later does not count as asleep', async () => {
  const ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const asleep = existsSync(paths.snapshotMeta);

  await ctx.client.imps.wake({ name: 'dev' });

  expect(asleep).toBeTrue();
  expect(existsSync(paths.snapshotMeta)).toBeFalse();
});

test('a VM a cut sleep left paused is resumed, and the half-written files go', async () => {
  const ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });

  const sleeping = ctx.fake.hold('sleep');

  void ctx.client.imps.sleep({ name: 'dev' });

  await sleeping.reached;

  const impd = ctx.restartImpd();

  const paths = await ctx.findPaths('dev');
  const running = await findImpByName(ctx.db, 'dev');

  const pid = running?.pid ?? 0;

  // the snapshot the cut sleep was writing
  mkdirSync(paths.snapshotDir, { recursive: true });
  writeFileSync(`${paths.vmstate}.new`, 'partial');
  writeFileSync(`${paths.memFile}.new`, 'partial');

  const paused = ctx.fake.readState(pid);

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(paused).toBe('Paused');
  expect(ctx.fake.readState(pid)).toBe('Running');
  expect(imp).toMatchObject({ state: 'running', pid });
  expect(existsSync(`${paths.vmstate}.new`)).toBeFalse();
  expect(existsSync(`${paths.memFile}.new`)).toBeFalse();
});

test('a VM a cut wake left running is adopted with its memory', async () => {
  const ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  // the wake loaded the snapshot; impd died before the record
  const pid = ctx.fake.spawnOrphan({ paths });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');
  const broken = await findBrokenInvariants(ctx, true);

  expect(imp).toMatchObject({ state: 'running', pid });
  expect(existsSync(paths.snapshotMeta)).toBeFalse();
  expect(broken).toEqual([]);
});

test('a VM a cut wake left before its load is killed, and the snapshot stays', async () => {
  const ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

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

test('a VM a cut wake left whose agent does not answer is killed, and the imp boots cold', async () => {
  const ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const pid = ctx.fake.spawnOrphan({ paths });

  ctx.fake.queue('agentReady', 'fail');

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');
  const broken = await findBrokenInvariants(ctx, true);

  expect(ctx.fake.alive.has(pid)).toBeFalse();
  expect(imp?.state).toBe('stopped');
  expect(existsSync(paths.snapshotMeta)).toBeFalse();
  expect(broken).toEqual([]);
});

test('a VM a cut wake left with another agent than the snapshot recorded is killed', async () => {
  const ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const meta = readSnapshotMeta(paths);

  if (meta === null) {
    throw new Error('no snapshot');
  }

  writeSnapshotMeta(paths, { ...meta, agentVersion: '0.0.1' });

  const pid = ctx.fake.spawnOrphan({ paths });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(ctx.fake.alive.has(pid)).toBeFalse();
  expect(imp?.state).toBe('stopped');
});

test('a second VM on a running imp socket is killed, and the one on the record stays', async () => {
  const ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });

  const paths = await ctx.findPaths('dev');
  const running = await findImpByName(ctx.db, 'dev');

  const owned = running?.pid ?? 0;
  const second = ctx.fake.spawnOrphan({ paths });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(ctx.fake.alive.has(second)).toBeFalse();
  expect(ctx.fake.alive.has(owned)).toBeTrue();
  expect(imp).toMatchObject({ state: 'running', pid: owned });
});

test('a start cut before its pid file leaves a VM only /proc shows, and it is killed', async () => {
  const ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const pid = ctx.fake.spawnOrphan({ paths, pidFile: false });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(ctx.fake.alive.has(pid)).toBeFalse();
  expect(imp?.state).toBe('stopped');
});

test('a VM on the socket of an imp with no record is killed', async () => {
  const ctx = await setupCrashTest();

  const pid = ctx.fake.spawnOrphan({ paths: buildImpPaths(ctx.dataDir, 'gone') });

  // a socket outside the data dir is not impd's to touch
  const foreign = ctx.fake.spawnOrphan({ paths: buildImpPaths('/elsewhere', 'gone') });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  expect(ctx.fake.alive.has(pid)).toBeFalse();
  expect(ctx.fake.alive.has(foreign)).toBeTrue();
});

test('a wake cut during its load, with no VM left, leaves the imp stopped, never on the old snapshot', async () => {
  const ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const waking = ctx.fake.hold('wake');

  void ctx.client.imps.wake({ name: 'dev' });

  await waking.reached;

  // the load runs the guest, which may write its disk; impd dies here
  expect(readSnapshotMeta(paths)).toBeNull();
  expect(readLoadingMeta(paths)).not.toBeNull();

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');
  const broken = await findBrokenInvariants(ctx, true);

  expect(imp?.state).toBe('stopped');
  expect(existsSync(paths.vmstate)).toBeFalse();
  expect(broken).toEqual([]);
});

test('a wake cut during its load whose VM runs on is adopted, and its record goes', async () => {
  const ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

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

// A process in imp `attacker`'s jail that execs `firecracker --api-sock` with
// another imp's socket: its argv says the victim, its uid and cgroup do not.
function buildForgedOwner(attacker: Readonly<{ id: string; jailUid: number | null }>) {
  return { uid: attacker.jailUid ?? 900_000, cgroup: `/imps/${attacker.id}` };
}

test('a VM forged on a sleeping imp socket from another jail is ignored, and the snapshot stays', async () => {
  const ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'evil' });
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const evil = await findImpByName(ctx.db, 'evil');
  const paths = await ctx.findPaths('dev');

  if (evil === undefined) {
    throw new Error('no evil imp');
  }

  // with no VM behind dev's socket, an adopt would find no state and drop the
  // snapshot; with the pid file pointing at it too
  const forged = ctx.fake.spawnOrphan({ paths, owner: buildForgedOwner(evil) });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(imp?.state).toBe('sleeping');
  expect(readSnapshotMeta(paths)).not.toBeNull();
  expect(ctx.fake.alive.has(forged)).toBeTrue();
  expect(ctx.fake.stops.map((stop) => stop.pid)).not.toContain(forged);
});

test('a VM forged on a running imp socket from another jail is not killed as its orphan', async () => {
  const ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'evil' });
  await ctx.client.imps.create({ name: 'dev' });

  const evil = await findImpByName(ctx.db, 'evil');
  const running = await findImpByName(ctx.db, 'dev');
  const paths = await ctx.findPaths('dev');

  if (evil === undefined || running?.pid === undefined || running.pid === null) {
    throw new Error('no imps');
  }

  const forged = ctx.fake.spawnOrphan({ paths, owner: buildForgedOwner(evil) });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(imp).toMatchObject({ state: 'running', pid: running.pid });
  expect(ctx.fake.alive.has(running.pid)).toBeTrue();
  expect(ctx.fake.stops).toEqual([]);
  expect(ctx.fake.alive.has(forged)).toBeTrue();
});

test('a jailed VM a cut wake left is adopted by its own uid, or by its own cgroup', async () => {
  const ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.create({ name: 'box' });
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'box' });

  const dev = await findImpByName(ctx.db, 'dev');
  const box = await findImpByName(ctx.db, 'box');

  if (dev === undefined || box === undefined) {
    throw new Error('no imps');
  }

  const devPaths = await ctx.findPaths('dev');
  const boxPaths = await ctx.findPaths('box');

  const byUid = ctx.fake.spawnOrphan({
    paths: devPaths,
    owner: { uid: dev.jailUid, cgroup: '/init' },
  });

  const byCgroup = ctx.fake.spawnOrphan({
    paths: boxPaths,
    owner: { uid: null, cgroup: `/imps/${box.id}` },
  });

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const adoptedDev = await findImpByName(ctx.db, 'dev');
  const adoptedBox = await findImpByName(ctx.db, 'box');

  expect(adoptedDev).toMatchObject({ state: 'running', pid: byUid });
  expect(adoptedBox).toMatchObject({ state: 'running', pid: byCgroup });
});

test('a VM forged on the socket of an imp with no record is not killed; one in its cgroup is', async () => {
  const ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'evil' });

  const evil = await findImpByName(ctx.db, 'evil');

  if (evil === undefined) {
    throw new Error('no evil imp');
  }

  const paths = buildImpPaths(ctx.dataDir, 'gone');
  const forged = ctx.fake.spawnOrphan({ paths, owner: buildForgedOwner(evil) });
  const jailed = ctx.fake.spawnOrphan({ paths, owner: { uid: 900_123, cgroup: '/imps/gone' } });
  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  expect(ctx.fake.alive.has(forged)).toBeTrue();
  expect(ctx.fake.alive.has(jailed)).toBeFalse();
});

test('a recycled pid whose argv another jail forged is a lost VM, never re-adopted into the cgroup', async () => {
  const ctx = await setupCrashTest();

  await ctx.client.imps.create({ name: 'evil' });
  await ctx.client.imps.create({ name: 'dev' });

  const evil = await findImpByName(ctx.db, 'evil');
  const running = await findImpByName(ctx.db, 'dev');

  if (evil === undefined || running?.pid === undefined || running.pid === null) {
    throw new Error('no imps');
  }

  // dev's VM died while impd was down, and evil's jail got its pid
  ctx.fake.setOwner(running.pid, buildForgedOwner(evil));

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  const imp = await findImpByName(ctx.db, 'dev');

  expect(imp).toMatchObject({ state: 'stopped', pid: null });
});

test('the orphan jails go before the orphan cgroups, so a cut-short build leaves its cgroup empty', async () => {
  const holder: { sweeps: string[] } = { sweeps: [] };

  const cgroups: CpuCgroups = {
    isEnforced: true,
    isMemoryEnforced: false,
    readOomKills: () => null,
    hasOomKillSinceStart: () => false,
    setup: () => null,
    apply: () => {},
    adopt: () => {},
    remove: () => Promise.resolve(),
    setGuestMib: () => {},
    kill: () => {},
    removeOrphans: () => {
      holder.sweeps.push('cgroups');

      return [];
    },
    readCpuStat: () => null,
  };

  const ctx = await setupImpTest({ cgroups });

  holder.sweeps = ctx.fake.sweeps;

  const impd = ctx.restartImpd();

  await impd.imps.reconcileImps();

  expect(ctx.fake.sweeps).toEqual(['jails', 'cgroups']);
});
