import { expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createCheckpoint, listCheckpoints } from '../db/checkpoints';
import { findImpByName, updateImpState } from '../db/imps';
import { setupImpTest } from '../imps/test-imps';
import { buildImpPaths } from '../storage/data-layout';
import type { BackupConfig } from './backup-config';
import { BackupManifestSchema } from './backup-manifest';
import { createBackupService } from './backup-service';
import type { Restic, ResticSnapshot } from './restic';

const HOUR_MS = 60 * 60 * 1000;

const CONFIG: BackupConfig = {
  repository: 'fake',
  passwordFile: '/dev/null',
  intervalS: 3600,
  keep: { hourly: 24, daily: 7, weekly: 4 },
  forget: true,
  cpus: 1,
  memoryMib: 64,
};

// restic over a directory: each snapshot is a copy of the tree
function createFakeRestic(repoDir: string, readNow: () => Date) {
  const snapshots: ResticSnapshot[] = [];
  const calls: string[] = [];
  const state = { failCheck: false };

  const findSnapshot = (id: string): ResticSnapshot => {
    const found = snapshots.find((snapshot) => snapshot.id === id);

    if (found === undefined) {
      throw new Error(`no snapshot ${id}`);
    }

    return found;
  };

  const resolvePath = (id: string, path: string) =>
    join(repoDir, id, relative(findSnapshot(id).paths[0] ?? '', path));

  const restic: Restic = {
    setupRepository: () => Promise.resolve(),
    backup: (dir, tags) => {
      const id = `snap${String(snapshots.length + 1)}`;

      cpSync(dir, join(repoDir, id), { recursive: true });

      snapshots.push({ id, time: readNow(), paths: [dir], tags: ['imp-backup', ...tags] });
      calls.push('backup');

      return Promise.resolve({
        snapshotId: id,
        filesNew: 0,
        filesChanged: 0,
        filesUnmodified: 0,
        dataAddedBytes: 10,
      });
    },
    forget: () => {
      calls.push('forget');

      return Promise.resolve();
    },
    prune: () => {
      calls.push('prune');

      return Promise.resolve();
    },
    check: () => {
      calls.push('check');

      return state.failCheck
        ? Promise.reject(new Error('Fatal: pack 9f2c: ciphertext verification failed'))
        : Promise.resolve();
    },
    unlock: () => {
      calls.push('unlock');

      return Promise.resolve();
    },
    listSnapshots: () => Promise.resolve([...snapshots]),
    dump: (id, path) => Promise.resolve(readFileSync(resolvePath(id, path), 'utf8')),
    restore: (id, dir, target) => {
      cpSync(resolvePath(id, dir), target, { recursive: true });

      return Promise.resolve();
    },
  };

  return { restic, snapshots, calls, state };
}

// Imps on the harness's XFS backend over a fake repository, which a second
// host can share to restore from (`repoDir`).
async function setupTest(repoDir = mkdtempSync(`${tmpdir()}/impd-restic-test-`)) {
  const harness = await setupImpTest();

  const clock = { now: new Date('2026-10-02T00:00:00Z') };
  const fake = createFakeRestic(repoDir, () => clock.now);
  const events: string[] = [];
  const logs: string[] = [];

  const backups = createBackupService({
    dataDir: harness.dataDir,
    backup: CONFIG,
    db: harness.db,
    imps: harness.imps,
    storage: harness.storage,
    restic: fake.restic,
    log: (message) => {
      logs.push(message);
    },
    now: () => clock.now,
    freezer: {
      freeze: () => {
        events.push('freeze');

        return Promise.resolve();
      },
      thaw: () => {
        events.push('thaw');

        return Promise.resolve();
      },
    },
  });

  const image = await harness.createTestImage('base');

  writeFileSync(join(harness.dataDir, 'images', 'base', 'config.json'), '{}');

  const findDisk = async (name: string) => {
    const imp = await findImpByName(harness.db, name);

    return buildImpPaths(harness.dataDir, imp?.id ?? '').disk;
  };

  const writeDisk = async (name: string, content: string) => {
    const disk = await findDisk(name);

    writeFileSync(disk, content);
  };

  // a checkpoint row and its disk, as the checkpoint service makes them
  const createDevCheckpoint = async (impId: string, label: string, createdAt: Date) => {
    const id = `cp-${label}`;

    const sizeBytes = await harness.storage.createCheckpoint(impId, id);

    await createCheckpoint(harness.db, { id, impId, label, sizeBytes, createdAt });
  };

  return {
    ...harness,
    image,
    repoDir,
    clock,
    fake,
    events,
    logs,
    backups,
    findDisk,
    readDisk: async (name: string) => {
      const disk = await findDisk(name);

      return readFileSync(disk, 'utf8');
    },
    writeDisk,

    // imp dev with checkpoints one and two, then the disk at "now"
    createDevImp: async () => {
      const dev = await harness.imps.createImp({ name: 'dev', httpPort: 3000, memoryMib: 256 });

      await writeDisk('dev', 'one');
      await createDevCheckpoint(dev.id, 'one', new Date('2026-09-01T00:00:00Z'));
      await writeDisk('dev', 'two');
      await createDevCheckpoint(dev.id, 'two', new Date('2026-09-02T00:00:00Z'));
      await writeDisk('dev', 'now');
    },
    readManifest: async (snapshotId: string) => {
      const snapshot = fake.snapshots.find((candidate) => candidate.id === snapshotId);
      const manifestPath = join(snapshot?.paths[0] ?? '', 'manifest.json');

      const text = await fake.restic.dump(snapshotId, manifestPath);

      return BackupManifestSchema.parse(JSON.parse(text));
    },
    advance: (ms: number) => {
      clock.now = new Date(clock.now.getTime() + ms);
    },
    async [Symbol.asyncDispose]() {
      await harness[Symbol.asyncDispose]();
    },
  };
}

test('a run freezes running imps, copies the rest as they are and lists what it holds', async () => {
  await using ctx = await setupTest();

  await ctx.createDevImp();
  await ctx.imps.createImp({ name: 'idle' });
  await ctx.imps.stopImp('idle');
  await ctx.imps.createImp({ name: 'napping' });
  await ctx.imps.sleepImp('napping');

  ctx.events.length = 0;

  const run = await ctx.backups.runBackup();

  expect(ctx.events).toEqual(['freeze', 'thaw']);
  expect(run.imps).toEqual(['dev', 'idle', 'napping']);
  expect(run.skipped).toEqual([]);

  expect(ctx.fake.snapshots[0]?.tags).toEqual([
    'imp-backup',
    expect.stringMatching(/^run=/),
    'imp=dev',
    'imp=idle',
    'imp=napping',
  ]);

  expect(ctx.fake.calls).toEqual(['backup', 'forget']);

  const manifest = await ctx.readManifest(run.snapshotId);

  const dev = manifest.imps.find((imp) => imp.name === 'dev');

  expect(manifest.imps.map((imp) => [imp.name, imp.state, imp.synced])).toEqual([
    ['dev', 'running', true],
    ['idle', 'stopped', true],
    ['napping', 'sleeping', false],
  ]);

  expect(dev).toMatchObject({ httpPort: 3000, memoryMib: 256, imageDigest: 'sha256:base' });
  expect(dev?.checkpoints.map((checkpoint) => checkpoint.label)).toEqual(['one', 'two']);
  expect(manifest.images.map((image) => image.digest)).toEqual(['sha256:base']);

  // the database copy and the token stay on the host
  const snapshotDir = join(ctx.repoDir, run.snapshotId);

  expect(readdirSync(snapshotDir).toSorted()).toEqual(['images', 'imps', 'manifest.json']);
  expect(readFileSync(join(snapshotDir, 'manifest.json'), 'utf8')).not.toContain('token');
});

test('a restore rebuilds the imp stopped, with its checkpoints in order', async () => {
  await using ctx = await setupTest();

  await ctx.createDevImp();
  await ctx.backups.runBackup();
  await ctx.imps.destroyImp('dev');

  const [restored] = await ctx.backups.restoreBackup({ name: 'dev' });

  expect(restored).toMatchObject({ name: 'dev', state: 'stopped', httpPort: 3000, memoryMib: 256 });

  const devDisk = await ctx.readDisk('dev');

  expect(devDisk).toBe('now');

  const imp = await findImpByName(ctx.db, 'dev');
  const checkpoints = await listCheckpoints(ctx.db, imp?.id ?? '');

  // newest first, with new ids and the original times
  expect(checkpoints.map((checkpoint) => [checkpoint.label, checkpoint.createdAt])).toEqual([
    ['two', new Date('2026-09-02T00:00:00Z')],
    ['one', new Date('2026-09-01T00:00:00Z')],
  ]);

  expect(checkpoints.map((checkpoint) => checkpoint.id)).not.toContain('cp-one');

  const checkpointsDir = buildImpPaths(ctx.dataDir, imp?.id ?? '').checkpointsDir;

  const readCheckpoint = (id: string | undefined) =>
    readFileSync(join(checkpointsDir, id ?? '', 'disk.ext4'), 'utf8');

  expect(readCheckpoint(checkpoints[1]?.id)).toBe('one');
  expect(readCheckpoint(checkpoints[0]?.id)).toBe('two');
  expect(existsSync(join(ctx.dataDir, 'backup', 'restore'))).toBeTrue();
  expect(readdirSync(join(ctx.dataDir, 'backup', 'restore'))).toEqual([]);
});

test('--at picks the newest backup at or before it that holds the imp', async () => {
  await using ctx = await setupTest();

  await ctx.createDevImp();
  await ctx.backups.runBackup();

  ctx.advance(HOUR_MS);

  await ctx.writeDisk('dev', 'later');
  await ctx.backups.runBackup();

  ctx.advance(HOUR_MS);

  await ctx.backups.restoreBackup({
    name: 'dev',
    as: 'early',
    at: new Date('2026-10-02T00:30:00Z'),
  });

  await ctx.backups.restoreBackup({ name: 'dev', as: 'late' });

  const earlyDisk = await ctx.readDisk('early');

  expect(earlyDisk).toBe('now');

  const lateDisk = await ctx.readDisk('late');

  expect(lateDisk).toBe('later');

  const before = await ctx.backups
    .restoreBackup({ name: 'dev', as: 'none', at: new Date('2026-10-01T00:00:00Z') })
    .catch(String);

  expect(before).toContain('not found');
});

test('a restore refuses a name in use and --all on a host with imps, unless merged', async () => {
  await using ctx = await setupTest();

  await ctx.createDevImp();
  await ctx.backups.runBackup();

  const clash = await ctx.backups.restoreBackup({ name: 'dev' }).catch((error: unknown) => error);

  expect(clash).toMatchObject({ code: 'CONFLICT', data: { kind: 'imp', name: 'dev' } });

  const all = await ctx.backups.restoreBackup({ all: true }).catch((error: unknown) => error);

  expect(all).toMatchObject({ code: 'PRECONDITION_FAILED' });

  const merged = await ctx.backups
    .restoreBackup({ all: true, merge: true })
    .catch((error: unknown) => error);

  expect(merged).toMatchObject({ code: 'CONFLICT', data: { name: 'dev' } });
});

test('restore --all on a fresh host brings back every imp and its image', async () => {
  await using source = await setupTest();

  await source.createDevImp();
  await source.imps.createImp({ name: 'web' });
  await source.backups.runBackup();

  await using fresh = await setupTest(source.repoDir);

  fresh.fake.snapshots.push(...source.fake.snapshots);

  // a different image under the same name: the restored one gets a suffix
  await fresh.db.deleteFrom('images').execute();

  rmSync(join(fresh.dataDir, 'images', 'base'), { recursive: true });

  await fresh.createTestImage('other');
  await fresh.db.updateTable('images').set({ name: 'base' }).execute();

  const restored = await fresh.backups.restoreBackup({ all: true });

  expect(restored.map((imp) => [imp.name, imp.state, imp.image])).toEqual([
    ['dev', 'stopped', 'base-base'],
    ['web', 'stopped', 'base-base'],
  ]);

  const freshDisk = await fresh.readDisk('dev');

  expect(freshDisk).toBe('now');
});

test('a restore that fails part way leaves no imp behind', async () => {
  await using ctx = await setupTest();

  await ctx.createDevImp();

  const run = await ctx.backups.runBackup();
  const manifest = await ctx.readManifest(run.snapshotId);

  const [dev] = manifest.imps;

  // a pack restic could not read: the newest disk is missing
  rmSync(join(ctx.repoDir, run.snapshotId, dev?.disk ?? ''));

  const failure = await ctx.backups.restoreBackup({ name: 'dev', as: 'copy' }).catch(String);

  expect(failure).toContain('ENOENT');

  const copy = await findImpByName(ctx.db, 'copy');

  expect(copy).toBeUndefined();
});

test('the schedule prunes once a day and checks once a week, loudly on failure', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev' });
  await ctx.backups.runScheduled();

  expect(ctx.fake.calls).toEqual(['backup', 'forget', 'unlock', 'prune', 'unlock', 'check']);

  ctx.fake.calls.length = 0;

  ctx.advance(HOUR_MS);

  await ctx.backups.runScheduled();

  expect(ctx.fake.calls).toEqual(['backup', 'forget']);

  ctx.fake.calls.length = 0;
  ctx.fake.state.failCheck = true;

  ctx.advance(7 * 24 * HOUR_MS);

  await ctx.backups.runScheduled();

  expect(ctx.fake.calls).toEqual(['backup', 'forget', 'unlock', 'prune', 'unlock', 'check']);

  expect(ctx.logs).toContain(
    'impd: backup: CHECK FAILED, the repository may be damaged: Fatal: pack 9f2c: ciphertext verification failed',
  );

  const status = await ctx.backups.readStatus();

  expect(status.points).toHaveLength(3);
  expect(status.lastCheck?.error).toContain('ciphertext verification failed');
});

test('an imp being created is left out of the run', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev' });

  const dev = await findImpByName(ctx.db, 'dev');

  await updateImpState(ctx.db, dev?.id ?? '', { state: 'creating' });

  const run = await ctx.backups.runBackup();

  expect(run.imps).toEqual([]);
  expect(run.skipped).toEqual([{ name: 'dev', reason: 'being created' }]);
});
