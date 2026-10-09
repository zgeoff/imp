import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Imp } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { createImp, findImpByName, updateImpState } from '../db/imps';
import { readSnapshotMeta, writeSnapshotMeta } from '../sleep/snapshot-meta';
import { readVmIdentity } from '../sleep/vm-identity';
import { buildImpPaths, buildSystemDrivePath } from '../storage/data-layout';
import { buildMockNewImp } from '../test-utils/build-mock-new-imp';
import { STUB_AGENT_VERSION } from '../test-utils/build-stub-vmm';
import { removeUnusedDrives } from './remove-unused-drives';
import { buildTestApp, createImpTest, findBrokenInvariants, waitForOutcome } from './test-imps';

// An upgrade as imp-host does it: SIGTERM sleeps every awake imp, and a new
// impd starts on a new system drive (an agent change), over the same data.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  // every create boots this image
  await harness.createTestImage('ubuntu');

  const findPaths = async (name: string) => {
    const imp = await findImpByName(harness.db, name);

    return buildImpPaths(harness.dataDir, imp?.id ?? '');
  };

  // a marker in each imp's disk, to see that no upgrade path touches it
  const writeDiskMarker = async (name: string) => {
    const paths = await findPaths(name);

    writeFileSync(paths.disk, `disk of ${name}`);
  };

  const readDisk = async (name: string) => {
    const paths = await findPaths(name);

    return readFileSync(paths.disk, 'utf8');
  };

  // the drive the imp's VM booted from
  const findVmDrive = async (name: string) => {
    const paths = await findPaths(name);

    return readVmIdentity(paths)?.systemDrive;
  };

  // a new impd on `drive` over the same data, as imp-host starts it after
  // the old one stopped or restarted in place
  const startImpdOnDrive = async (drive: string) => {
    const impd = harness.restartImpd(harness.createSystemDrive(drive));

    await impd.imps.reconcileImps();

    // as main does once the imps are reconciled
    const pruned = await removeUnusedDrives(
      harness.db,
      harness.dataDir,
      harness.storage.resolveImpPaths,
      harness.readIdentity().systemDrivePath,
    );

    return { impd, client: buildTestApp(harness, impd).client, pruned };
  };

  return {
    ...harness,

    // the drive the imps are created on, before any upgrade
    oldDrive: harness.readIdentity().systemDrive,
    client: buildTestApp(harness, harness).client,
    findPaths,
    writeDiskMarker,
    readDisk,
    findVmDrive,
    startImpdOnDrive,
  };
}

test('it keeps every imp through an agent upgrade, and asleep on the kept drive', async () => {
  const ctx = await setupTest();

  for (const name of ['awake', 'held', 'asleep', 'off']) {
    await ctx.client.imps.create({ name });
  }

  await ctx.client.imps.hold({ name: 'held', seconds: 3600 });
  await ctx.client.imps.sleep({ name: 'asleep' });
  await ctx.client.imps.stop({ name: 'off' });

  ctx.fake.queue('boot', 'fail');

  const broken = await waitForOutcome(ctx.client.imps.create({ name: 'broken' }), 10_000);
  const image = await ctx.images.resolveImage('ubuntu');

  // a create impd never finished
  const creating = await createImp(
    ctx.db,
    buildMockNewImp({ name: 'creating', imageId: image.id, slot: 9, ip: '10.66.0.38' }),
  );

  await updateImpState(ctx.db, creating.id, { reason: 'failed', state: 'creating' });

  const oldDrive = ctx.readIdentity().systemDrivePath;

  await ctx.imps.sleepAllImps();

  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));
  const imps = await upgraded.client.imps.list();

  const listed = new Map(imps.map((imp) => [imp.name, imp]));

  expect(broken).toBe('failed');
  expect(upgraded.pruned).toBeEmpty();
  expect(existsSync(oldDrive)).toBeTrue();
  expect(listed.get('awake')).toMatchObject({ state: 'sleeping', outdated: ['agent'] });
  expect(listed.get('held')).toMatchObject({ state: 'sleeping', outdated: ['agent'] });
  expect(listed.get('asleep')).toMatchObject({ state: 'sleeping', outdated: ['agent'] });
  expect(listed.get('off')?.state).toBe('stopped');
  expect(listed.get('broken')?.state).toBe('error');
  expect(listed.get('creating')?.state).toBe('error');
  expect(imps).toSatisfyAll((imp: Readonly<Imp>) => imp.coldBootReason === undefined);
});

test('it wakes a kept imp on the old agent and starts a stopped one on the new', async () => {
  const ctx = await setupTest();

  for (const name of ['awake', 'held', 'asleep', 'off']) {
    await ctx.client.imps.create({ name });
    await ctx.writeDiskMarker(name);
  }

  await ctx.client.imps.hold({ name: 'held', seconds: 3600 });
  await ctx.client.imps.sleep({ name: 'asleep' });
  await ctx.client.imps.stop({ name: 'off' });
  await ctx.imps.sleepAllImps();

  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));

  const wakesBefore = ctx.fake.wakes.length;

  const woken = await upgraded.client.imps.wake({ name: 'asleep' });
  const started = await upgraded.client.imps.start({ name: 'off' });
  const startedDrive = await ctx.findVmDrive('off');

  const disks = await Promise.all(
    ['awake', 'held', 'asleep', 'off'].map((name) => ctx.readDisk(name)),
  );

  const invariants = await findBrokenInvariants(ctx, true);

  expect(ctx.fake.wakes).toHaveLength(wakesBefore + 1);
  expect(woken).toMatchObject({ state: 'running', outdated: ['agent'] });
  expect(started.state).toBe('running');
  expect(started.outdated).toBeUndefined();
  expect(startedDrive).toBe('d2'.repeat(32));
  expect(disks).toStrictEqual(['disk of awake', 'disk of held', 'disk of asleep', 'disk of off']);
  expect(invariants).toBeEmpty();
});

test('it says why a sleeping imp whose drive is gone boots cold', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.imps.sleepAllImps();

  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));

  rmSync(buildSystemDrivePath(ctx.dataDir, ctx.oldDrive));

  const asleep = await upgraded.client.imps.get({ name: 'dev' });

  expect(asleep).toMatchObject({
    state: 'sleeping',
    coldBootReason: `its agent drive ${ctx.oldDrive.slice(0, 12)} is gone`,
  });
});

test('it boots cold a sleeping imp whose drive is gone, and keeps its disk', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.writeDiskMarker('dev');
  await ctx.imps.sleepAllImps();

  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));

  rmSync(buildSystemDrivePath(ctx.dataDir, ctx.oldDrive));

  const wakesBefore = ctx.fake.wakes.length;

  const woken = await upgraded.client.imps.wake({ name: 'dev' });
  const disk = await ctx.readDisk('dev');

  expect(ctx.fake.wakes).toHaveLength(wakesBefore);
  expect(woken.state).toBe('running');
  expect(woken.coldBootReason).toBe(`its agent drive ${ctx.oldDrive.slice(0, 12)} is gone`);
  expect(woken.outdated).toBeUndefined();
  expect(disk).toBe('disk of dev');
});

test('it marks a VM re-adopted after a drive change as on the old agent', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  // SIGHUP: impd restarts on the new drive and the VM keeps running
  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));
  const awake = await upgraded.client.imps.get({ name: 'dev' });

  expect(upgraded.pruned).toBeEmpty();
  expect(awake.outdated).toStrictEqual(['agent']);
});

test('it records in the snapshot the drive a re-adopted VM booted from', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const oldDrivePath = ctx.readIdentity().systemDrivePath;

  // SIGHUP: impd restarts on the new drive and the VM keeps running
  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));

  await upgraded.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  expect(readSnapshotMeta(paths)).toMatchObject({
    systemDrive: ctx.oldDrive,
    systemDrivePath: oldDrivePath,
  });
});

test('it wakes a re-adopted VM from the old drive its snapshot names', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  // SIGHUP: impd restarts on the new drive and the VM keeps running
  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));

  await upgraded.client.imps.sleep({ name: 'dev' });

  const woken = await upgraded.client.imps.wake({ name: 'dev' });

  expect(woken.coldBootReason).toBeUndefined();
  expect(ctx.fake.wakes).toHaveLength(1);
});

test('it keeps the newer drive on a downgrade while a snapshot names it', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.imps.sleepAllImps();

  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));

  await upgraded.client.imps.stop({ name: 'dev' });
  await upgraded.client.imps.start({ name: 'dev' });
  await upgraded.impd.imps.sleepAllImps();

  const downgraded = await ctx.startImpdOnDrive(ctx.oldDrive);

  expect(downgraded.pruned).toBeEmpty();
});

test('it wakes on a downgrade the snapshot the newer drive wrote', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.imps.sleepAllImps();

  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));

  await upgraded.client.imps.stop({ name: 'dev' });
  await upgraded.client.imps.start({ name: 'dev' });
  await upgraded.impd.imps.sleepAllImps();

  const downgraded = await ctx.startImpdOnDrive(ctx.oldDrive);
  const woken = await downgraded.client.imps.wake({ name: 'dev' });
  const wokenDrive = await ctx.findVmDrive('dev');

  expect(woken).toMatchObject({ state: 'running', outdated: ['agent'] });
  expect(wokenDrive).toBe('d2'.repeat(32));
});

test('it prunes the newer drive once nothing names it', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.imps.sleepAllImps();

  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));

  await upgraded.client.imps.stop({ name: 'dev' });
  await upgraded.client.imps.start({ name: 'dev' });
  await upgraded.impd.imps.sleepAllImps();

  const downgraded = await ctx.startImpdOnDrive(ctx.oldDrive);

  await downgraded.client.imps.wake({ name: 'dev' });
  await downgraded.client.imps.stop({ name: 'dev' });

  const again = await ctx.startImpdOnDrive(ctx.oldDrive);

  expect(again.pruned).toStrictEqual([`${'d2'.repeat(32)}.squashfs`]);
});

test('it says a snapshot from an older impd boots cold', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const meta = readSnapshotMeta(paths);

  invariant(meta);

  // an older impd wrote no drive path and hashed with Bun.hash
  const { systemDrivePath: _path, agentVersion: _agent, ...legacy } = meta;

  writeSnapshotMeta(paths, { ...legacy, systemDrive: '9f3c51a07e2b44d1' });

  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));
  const asleep = await upgraded.client.imps.get({ name: 'dev' });

  expect(asleep).toMatchObject({
    state: 'sleeping',
    coldBootReason: 'the snapshot is from an older impd',
  });
});

test('it boots cold once a snapshot from an older impd, and keeps the disk', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.writeDiskMarker('dev');
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const meta = readSnapshotMeta(paths);

  invariant(meta);

  // an older impd wrote no drive path and hashed with Bun.hash
  const { systemDrivePath: _path, agentVersion: _agent, ...legacy } = meta;

  writeSnapshotMeta(paths, { ...legacy, systemDrive: '9f3c51a07e2b44d1' });

  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));
  const woken = await upgraded.client.imps.wake({ name: 'dev' });
  const disk = await ctx.readDisk('dev');

  expect(woken.state).toBe('running');
  expect(ctx.fake.wakes).toBeEmpty();
  expect(disk).toBe('disk of dev');
});

test('it boots cold when the woken agent is not the one the snapshot recorded', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const meta = readSnapshotMeta(paths);

  invariant(meta);
  writeSnapshotMeta(paths, { ...meta, agentVersion: '0.0.9' });

  const woken = await ctx.client.imps.wake({ name: 'dev' });

  expect(woken).toMatchObject({
    state: 'running',
    coldBootReason: `the agent answered as ${STUB_AGENT_VERSION}, not 0.0.9`,
  });

  expect(ctx.fake.wakes).toHaveLength(1);
  expect(ctx.fake.alive.size).toBe(1);
});

test('it keeps the disk to a woken VM with the wrong agent that will not stop', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const meta = readSnapshotMeta(paths);

  invariant(meta);
  writeSnapshotMeta(paths, { ...meta, agentVersion: '0.0.9' });

  ctx.fake.queue('stop', 'fail');

  const outcome = await waitForOutcome(ctx.client.imps.wake({ name: 'dev' }), 10_000);
  const imp = await findImpByName(ctx.db, 'dev');
  const invariants = await findBrokenInvariants(ctx, true);

  // no cold boot: the VM that would not stop still has the disk open
  expect(outcome).toBe('failed');
  expect(ctx.fake.alive.size).toBe(1);
  expect(ctx.fake.wakes).toHaveLength(1);
  expect(imp).toMatchObject({ state: 'error', pid: ctx.fake.wakes[0] });
  expect(invariants).toBeEmpty();
});

test('it runs a boot whose vm.json cannot be written, and logs why', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  // a directory in the way: the rename over it fails, as a full disk would
  rmSync(paths.vmIdentity);
  mkdirSync(`${paths.vmIdentity}/blocked`, { recursive: true });

  const started = await ctx.client.imps.start({ name: 'dev' });

  expect(started.state).toBe('running');

  expect(ctx.logs).toSatisfyAny((line: string) =>
    line.startsWith('impd: dev: could not write vm.json'),
  );
});

test('it marks a VM booted by an impd that kept no identity as from an older impd', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  rmSync(paths.vmIdentity);

  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));
  const awake = await upgraded.client.imps.get({ name: 'dev' });

  expect(awake.outdated).toStrictEqual(['impd']);
});

test('it says the next wake of a VM booted by an impd that kept no identity boots cold', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  rmSync(paths.vmIdentity);

  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));

  await upgraded.client.imps.sleep({ name: 'dev' });

  const asleep = await upgraded.client.imps.get({ name: 'dev' });

  expect(asleep.coldBootReason).toBe('the snapshot is from an older impd');
});

test('it clears on a sleep the reason the last boot was cold', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.imps.sleepAllImps();

  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));

  rmSync(buildSystemDrivePath(ctx.dataDir, ctx.oldDrive));

  const coldBooted = await upgraded.client.imps.wake({ name: 'dev' });

  await upgraded.client.imps.sleep({ name: 'dev' });

  const woken = await upgraded.client.imps.wake({ name: 'dev' });

  expect(coldBooted.coldBootReason).toBe(`its agent drive ${ctx.oldDrive.slice(0, 12)} is gone`);
  expect(woken.coldBootReason).toBeUndefined();
  expect(ctx.fake.wakes).toHaveLength(1);
});

test('it never removes a drive in use when the data dir moved, by its file name', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const meta = readSnapshotMeta(paths);

  invariant(meta);

  // the snapshot names the drive under the data dir's old place
  writeSnapshotMeta(paths, {
    ...meta,
    systemDrivePath: `/old/imp/system/drives/${ctx.oldDrive}.squashfs`,
  });

  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));

  expect(upgraded.pruned).toBeEmpty();
  expect(existsSync(buildSystemDrivePath(ctx.dataDir, ctx.oldDrive))).toBeTrue();
});

test('it counts in system.info the imps an agent upgrade left outdated or without a snapshot', async () => {
  const ctx = await setupTest();

  for (const name of ['kept', 'lost', 'off']) {
    await ctx.client.imps.create({ name });
  }

  await ctx.client.imps.stop({ name: 'off' });
  await ctx.imps.sleepAllImps();

  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));

  // a sleeping imp whose snapshot is gone has nothing to load
  const lost = await ctx.findPaths('lost');

  rmSync(lost.snapshotDir, { recursive: true });

  const info = await upgraded.client.system.info();

  expect(info.bootStatus).toStrictEqual({
    coldBoots: 1,
    outdated: { firecracker: 0, kernel: 0, agent: 1 },
  });
});

test('it boots cold a sleeping imp whose snapshot is gone after an agent upgrade', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'lost' });
  await ctx.imps.sleepAllImps();

  const upgraded = await ctx.startImpdOnDrive('d2'.repeat(32));
  const lost = await ctx.findPaths('lost');

  rmSync(lost.snapshotDir, { recursive: true });

  const wakesBefore = ctx.fake.wakes.length;

  const woken = await upgraded.client.imps.wake({ name: 'lost' });

  expect(woken.state).toBe('running');
  expect(ctx.fake.wakes).toHaveLength(wakesBefore);
});

test('it counts in system.info a running imp on an older firecracker as a cold boot to come', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  // a new Firecracker re-adopts the VM the old one runs
  const impd = ctx.restartImpd({ ...ctx.readIdentity(), firecrackerVersion: 'v1.18.0' });

  await impd.imps.reconcileImps();

  const info = await buildTestApp(ctx, impd).client.system.info();

  expect(info.bootStatus).toStrictEqual({
    coldBoots: 1,
    outdated: { firecracker: 1, kernel: 0, agent: 0 },
  });
});

test('it says a running imp on an older firecracker boots cold after its sleep', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  // a new Firecracker re-adopts the VM the old one runs
  const impd = ctx.restartImpd({ ...ctx.readIdentity(), firecrackerVersion: 'v1.18.0' });

  await impd.imps.reconcileImps();

  const client = buildTestApp(ctx, impd).client;

  await client.imps.sleep({ name: 'dev' });

  const asleep = await client.imps.get({ name: 'dev' });

  expect(asleep.coldBootReason).toBe('firecrackerVersion changed (v1.17.0 → v1.18.0)');
});
