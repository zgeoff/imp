import { expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createImp, findImpByName, updateImpState } from '../db/imps';
import { readSnapshotMeta, writeSnapshotMeta } from '../sleep/snapshot-meta';
import { readVmIdentity } from '../sleep/vm-identity';
import { buildImpPaths, buildSystemDrivePath } from '../storage/data-layout';
import { removeUnusedSystemDrives } from '../storage/remove-unused-system-drives';
import { listDrivesInUse } from './drives-in-use';
import { FAKE_AGENT_VERSION } from './fake-vmm';
import { buildTestApp, findBrokenInvariants, setupImpTest, waitForOutcome } from './test-imps';

// An upgrade as imp-host does it: SIGTERM sleeps every awake imp, and a new
// impd starts on a new system drive (an agent change), over the same data.

const NEW_DRIVE = 'd2'.repeat(32);

async function setupUpgradeTest() {
  const ctx = await setupImpTest();

  await ctx.createTestImage('ubuntu');

  const findPaths = async (name: string) => {
    const imp = await findImpByName(ctx.db, name);

    return buildImpPaths(ctx.dataDir, imp?.id ?? '');
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

  // what main does once the imps are reconciled
  const removeUnusedDrives = async () => {
    const keep = await listDrivesInUse(ctx.db, ctx.dataDir);

    keep.add(ctx.readIdentity().systemDrivePath);

    return removeUnusedSystemDrives(ctx.dataDir, keep);
  };

  const current = { imps: ctx.imps };

  const runUpgrade = async (drive: string, sleepFirst = true) => {
    if (sleepFirst) {
      await current.imps.sleepAllImps();
    }

    const impd = ctx.restartImpd(ctx.createSystemDrive(drive));

    current.imps = impd.imps;

    await impd.imps.reconcileImps();

    const pruned = await removeUnusedDrives();

    return { impd, client: buildTestApp(ctx, impd).client, pruned };
  };

  const client = buildTestApp(ctx, ctx).client;

  // imps in every state: awake, held, asleep, stopped, failed, and one whose
  // create impd never finished
  const createEveryState = async () => {
    for (const name of ['awake', 'held', 'asleep', 'off']) {
      await client.imps.create({ name });

      await writeDiskMarker(name);
    }

    await client.imps.hold({ name: 'held', seconds: 3600 });
    await client.imps.sleep({ name: 'asleep' });
    await client.imps.stop({ name: 'off' });

    ctx.fake.queue('boot', 'fail');

    const broken = await waitForOutcome(client.imps.create({ name: 'broken' }), 10_000);
    const image = await ctx.images.resolveImage('ubuntu');

    const creating = await createImp(ctx.db, {
      name: 'creating',
      imageId: image.id,
      vcpus: 1,
      memoryMib: 512,
      slot: 9,
      ip: '10.66.0.38',
    });

    await updateImpState(ctx.db, creating.id, { state: 'creating' });

    return broken;
  };

  return {
    ...ctx,

    // the drive the imps are created on, before any upgrade
    oldDrive: ctx.readIdentity().systemDrive,
    client,
    findPaths,
    writeDiskMarker,
    readDisk,
    findVmDrive,
    createEveryState,
    runUpgrade,
  };
}

test('an agent upgrade keeps every imp, and kept drives restore their memory', async () => {
  await using ctx = await setupUpgradeTest();

  const broken = await ctx.createEveryState();

  const oldDrive = ctx.readIdentity().systemDrivePath;

  const upgraded = await ctx.runUpgrade(NEW_DRIVE);

  const client = upgraded.client;

  const imps = await client.imps.list();

  const listed = new Map(imps.map((imp) => [imp.name, imp]));

  expect(broken).toBe('failed');
  expect(upgraded.pruned).toEqual([]);
  expect(existsSync(oldDrive)).toBeTrue();
  expect(listed.get('awake')).toMatchObject({ state: 'sleeping', outdated: ['agent'] });
  expect(listed.get('held')).toMatchObject({ state: 'sleeping', outdated: ['agent'] });
  expect(listed.get('asleep')).toMatchObject({ state: 'sleeping', outdated: ['agent'] });
  expect(listed.get('off')?.state).toBe('stopped');
  expect(listed.get('broken')?.state).toBe('error');
  expect(listed.get('creating')).toMatchObject({ state: 'error' });

  for (const imp of listed.values()) {
    expect(imp.coldBootReason).toBeUndefined();
  }

  // a woken imp runs the old agent from the kept drive; a started one the new
  const wakesBefore = ctx.fake.wakes.length;

  const woken = await client.imps.wake({ name: 'asleep' });
  const started = await client.imps.start({ name: 'off' });

  expect(ctx.fake.wakes.length).toBe(wakesBefore + 1);
  expect(woken).toMatchObject({ state: 'running', outdated: ['agent'] });
  expect(started.state).toBe('running');
  expect(started.outdated).toBeUndefined();

  const startedDrive = await ctx.findVmDrive('off');

  const names = ['awake', 'held', 'asleep', 'off'];

  const disks = await Promise.all(names.map((name) => ctx.readDisk(name)));
  const invariants = await findBrokenInvariants(ctx, true);

  expect(startedDrive).toBe(NEW_DRIVE);
  expect(disks).toEqual(names.map((name) => `disk of ${name}`));
  expect(invariants).toEqual([]);
});

test('a sleeping imp whose drive is gone boots cold, says why and keeps its disk', async () => {
  await using ctx = await setupUpgradeTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.writeDiskMarker('dev');

  const upgraded = await ctx.runUpgrade(NEW_DRIVE);

  const client = upgraded.client;

  rmSync(buildSystemDrivePath(ctx.dataDir, ctx.oldDrive));

  const asleep = await client.imps.get({ name: 'dev' });

  expect(asleep).toMatchObject({
    state: 'sleeping',
    coldBootReason: `its agent drive ${ctx.oldDrive.slice(0, 12)} is gone`,
  });

  const wakesBefore = ctx.fake.wakes.length;

  const woken = await client.imps.wake({ name: 'dev' });

  expect(ctx.fake.wakes.length).toBe(wakesBefore);
  expect(woken.state).toBe('running');
  expect(woken.coldBootReason).toBe(asleep.coldBootReason);
  expect(woken.outdated).toBeUndefined();

  const disk = await ctx.readDisk('dev');

  expect(disk).toBe('disk of dev');
});

test('a VM re-adopted after a drive change records the drive it booted from', async () => {
  await using ctx = await setupUpgradeTest();

  await ctx.client.imps.create({ name: 'dev' });

  const oldDrive = ctx.readIdentity().systemDrivePath;

  // SIGHUP: impd restarts on the new drive and the VM keeps running
  const upgraded = await ctx.runUpgrade(NEW_DRIVE, false);

  const client = upgraded.client;

  const awake = await client.imps.get({ name: 'dev' });

  expect(upgraded.pruned).toEqual([]);
  expect(awake.outdated).toEqual(['agent']);

  await client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const meta = readSnapshotMeta(paths);

  expect(meta).toMatchObject({ systemDrive: ctx.oldDrive, systemDrivePath: oldDrive });

  // the snapshot reopens the old drive, which stays while it is named
  const woken = await client.imps.wake({ name: 'dev' });

  expect(woken.coldBootReason).toBeUndefined();
  expect(ctx.fake.wakes).toHaveLength(1);
});

test('a downgrade restores snapshots the newer drive wrote while that drive is kept', async () => {
  await using ctx = await setupUpgradeTest();

  await ctx.client.imps.create({ name: 'dev' });

  const upgraded = await ctx.runUpgrade(NEW_DRIVE);

  await upgraded.client.imps.stop({ name: 'dev' });
  await upgraded.client.imps.start({ name: 'dev' });

  const downgraded = await ctx.runUpgrade(ctx.oldDrive);

  const client = downgraded.client;

  expect(downgraded.pruned).toEqual([]);

  const woken = await client.imps.wake({ name: 'dev' });
  const wokenDrive = await ctx.findVmDrive('dev');

  expect(woken).toMatchObject({ state: 'running', outdated: ['agent'] });
  expect(wokenDrive).toBe(NEW_DRIVE);

  // once nothing names the newer drive, the next start prunes it
  await client.imps.stop({ name: 'dev' });

  const again = await ctx.runUpgrade(ctx.oldDrive);

  expect(again.pruned).toEqual([`${NEW_DRIVE}.squashfs`]);
});

test('a snapshot from an older impd stays asleep and boots cold once', async () => {
  await using ctx = await setupUpgradeTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.writeDiskMarker('dev');
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const meta = readSnapshotMeta(paths);

  if (meta === null) {
    throw new Error('no snapshot');
  }

  // an older impd wrote no drive path and hashed with Bun.hash
  const { systemDrivePath: _path, agentVersion: _agent, ...legacy } = meta;

  writeSnapshotMeta(paths, { ...legacy, systemDrive: '9f3c51a07e2b44d1' });

  const upgraded = await ctx.runUpgrade(NEW_DRIVE);

  const client = upgraded.client;

  const asleep = await client.imps.get({ name: 'dev' });

  expect(asleep).toMatchObject({
    state: 'sleeping',
    coldBootReason: 'the snapshot is from an older impd',
  });

  const woken = await client.imps.wake({ name: 'dev' });

  expect(woken.state).toBe('running');
  expect(ctx.fake.wakes).toHaveLength(0);

  const disk = await ctx.readDisk('dev');

  expect(disk).toBe('disk of dev');
});

test('a woken agent that is not the one the snapshot recorded boots cold', async () => {
  await using ctx = await setupUpgradeTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = await ctx.findPaths('dev');

  const meta = readSnapshotMeta(paths);

  if (meta === null) {
    throw new Error('no snapshot');
  }

  writeSnapshotMeta(paths, { ...meta, agentVersion: '0.0.9' });

  const woken = await ctx.client.imps.wake({ name: 'dev' });

  expect(woken).toMatchObject({
    state: 'running',
    coldBootReason: `the agent answered as ${FAKE_AGENT_VERSION}, not 0.0.9`,
  });

  expect(ctx.fake.wakes).toHaveLength(1);
  expect(ctx.fake.alive.size).toBe(1);
});
