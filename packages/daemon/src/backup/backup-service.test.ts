import { expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createCheckpoint, listCheckpoints } from '../db/checkpoints';
import { findImpByName, updateImpState } from '../db/imps';
import { setupImpTest } from '../imps/test-imps';
import { buildImpPaths } from '../storage/data-layout';
import type { BackupConfig } from './backup-config';
import { BackupManifestSchema } from './backup-manifest';
import { createBackupService } from './backup-service';
import { ResticError } from './restic';
import type { Restic, ResticSnapshot } from './restic';

const HOUR_MS = 60 * 60 * 1000;

const LOCKED = new ResticError(
  'restic prune exited 11: unable to create lock in backend: repository is already locked exclusively by PID 7 on imp-host by root (UID 0, GID 0)',
  11,
);

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

  // pruneErrors: what the next prunes throw, one each
  const state = { failCheck: false, failBackup: false, pruneErrors: [] as Error[] };
  const restores: string[] = [];

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
      if (state.failBackup) {
        return Promise.reject(new Error('Fatal: unable to save snapshot: bucket full'));
      }

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

      const failure = state.pruneErrors.shift();

      return failure === undefined ? Promise.resolve() : Promise.reject(failure);
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
      restores.push(relative(findSnapshot(id).paths[0] ?? '', dir));

      cpSync(resolvePath(id, dir), target, { recursive: true });

      return Promise.resolve();
    },
  };

  return { restic, snapshots, calls, state, restores };
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
    grants: harness.broker,
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

    // a size of its own, so a restore shows it took the manifest's
    const diskBytes = 1000 + label.length;

    await createCheckpoint(harness.db, { id, impId, label, sizeBytes, createdAt, diskBytes });
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

  expect(ctx.fake.calls).toEqual(['unlock', 'backup', 'forget']);

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

  const result = await ctx.backups.restoreBackup({ name: 'dev' });

  const [restored] = result.imps;

  expect(restored).toMatchObject({ name: 'dev', state: 'stopped', httpPort: 3000, memoryMib: 256 });

  const devDisk = await ctx.readDisk('dev');

  expect(devDisk).toBe('now');

  const imp = await findImpByName(ctx.db, 'dev');
  const checkpoints = await listCheckpoints(ctx.db, imp?.id ?? '');

  // newest first, with new ids and the original times and disk sizes
  expect(
    checkpoints.map((checkpoint) => [checkpoint.label, checkpoint.createdAt, checkpoint.diskBytes]),
  ).toEqual([
    ['two', new Date('2026-09-02T00:00:00Z'), 1003],
    ['one', new Date('2026-09-01T00:00:00Z'), 1003],
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

  expect(restored.imps.map((imp) => [imp.name, imp.state, imp.image])).toEqual([
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

  expect(ctx.fake.calls).toEqual([
    'unlock',
    'backup',
    'forget',
    'unlock',
    'prune',
    'unlock',
    'check',
  ]);

  // not due before an interval has passed
  ctx.fake.calls.length = 0;

  ctx.advance(HOUR_MS / 2);

  await ctx.backups.runScheduled();

  expect(ctx.fake.calls).toEqual([]);

  ctx.advance(HOUR_MS / 2);

  await ctx.backups.runScheduled();

  expect(ctx.fake.calls).toEqual(['unlock', 'backup', 'forget']);

  ctx.fake.calls.length = 0;
  ctx.fake.state.failCheck = true;

  ctx.advance(7 * 24 * HOUR_MS);

  await ctx.backups.runScheduled();

  expect(ctx.fake.calls).toEqual([
    'unlock',
    'backup',
    'forget',
    'unlock',
    'prune',
    'unlock',
    'check',
  ]);

  expect(ctx.logs).toContain(
    'impd: backup: CHECK FAILED, the repository may be damaged: Fatal: pack 9f2c: ciphertext verification failed',
  );

  const status = await ctx.backups.readStatus();

  expect(status.points).toHaveLength(3);
  expect(status.lastCheck?.error).toContain('ciphertext verification failed');
});

test('a prune that meets a lock tries again on the next tick, not the next run', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev' });

  ctx.fake.state.pruneErrors.push(LOCKED);

  await ctx.backups.runScheduled();

  expect(ctx.logs.some((line) => line.includes('PRUNE FAILED'))).toBeTrue();

  // the next tick, well inside the interval
  ctx.fake.calls.length = 0;

  ctx.advance(5 * 60 * 1000);

  await ctx.backups.runScheduled();

  expect(ctx.fake.calls).toEqual(['unlock', 'prune']);

  const status = await ctx.backups.readStatus();

  expect(status.lastPruneAt).not.toBeNull();

  // done: the tick after does nothing
  ctx.fake.calls.length = 0;

  ctx.advance(5 * 60 * 1000);

  await ctx.backups.runScheduled();

  expect(ctx.fake.calls).toEqual([]);
});

test('after six prunes in a row meet a lock, the next try waits for a run', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev' });

  ctx.fake.state.pruneErrors.push(...Array.from({ length: 7 }, () => LOCKED));

  // the run's prune, then five ticks: six in all
  await ctx.backups.runScheduled();

  ctx.fake.calls.length = 0;

  for (let tick = 0; tick < 6; tick += 1) {
    ctx.advance(5 * 60 * 1000);

    await ctx.backups.runScheduled();
  }

  expect(ctx.fake.calls.filter((call) => call === 'prune')).toHaveLength(5);

  // the next run starts a new series: its prune meets the seventh lock, and
  // the tick after it succeeds
  ctx.fake.calls.length = 0;

  ctx.advance(HOUR_MS);

  await ctx.backups.runScheduled();

  ctx.advance(5 * 60 * 1000);

  await ctx.backups.runScheduled();

  expect(ctx.fake.calls).toEqual([
    'unlock',
    'backup',
    'forget',
    'unlock',
    'prune',
    'unlock',
    'prune',
  ]);

  const status = await ctx.backups.readStatus();

  expect(status.lastPruneAt).not.toBeNull();
});

test('a prune that fails for another reason waits for the next run', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev' });

  ctx.fake.state.pruneErrors.push(new ResticError('restic prune exited 1: Fatal: bucket full', 1));

  await ctx.backups.runScheduled();

  ctx.fake.calls.length = 0;

  ctx.advance(5 * 60 * 1000);

  await ctx.backups.runScheduled();

  expect(ctx.fake.calls).toEqual([]);

  ctx.advance(HOUR_MS);

  await ctx.backups.runScheduled();

  expect(ctx.fake.calls).toEqual(['unlock', 'backup', 'forget', 'unlock', 'prune']);
});

test('an imp being created is left out of the run', async () => {
  await using ctx = await setupTest();

  await ctx.imps.createImp({ name: 'dev' });

  const dev = await findImpByName(ctx.db, 'dev');

  await updateImpState(ctx.db, dev?.id ?? '', { reason: 'failed', state: 'creating' });

  const run = await ctx.backups.runBackup();

  expect(run.imps).toEqual([]);
  expect(run.skipped).toEqual([{ name: 'dev', reason: 'being created' }]);
});

// every file under dir, by path relative to it, with its text
function readTree(dir: string): Map<string, string> {
  const files = new Map<string, string>();

  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);

      files.set(relative(dir, path), readFileSync(path, 'latin1'));
    }
  }

  return files;
}

test('no secret, key, password or token of the host reaches a backup', async () => {
  await using ctx = await setupTest();

  await ctx.createDevImp();
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_never_backed_up' });
  await ctx.broker.addGrant('dev', 'gh');

  mkdirSync(join(ctx.dataDir, 'tls'), { recursive: true });
  writeFileSync(join(ctx.dataDir, 'tls', 'account.json'), 'acme-account-key-text');
  writeFileSync(join(ctx.dataDir, 'restic-password'), 'restic-password-text');
  writeFileSync(join(ctx.dataDir, 'token'), 'api-token-text');

  const run = await ctx.backups.runBackup();

  const files = readTree(join(ctx.repoDir, run.snapshotId));
  const paths = [...files.keys()];
  const texts = [...files.values()].join('\n');

  expect(
    paths.filter((path) => /secrets|broker|tls|password|token|db\.sqlite/v.test(path)),
  ).toEqual([]);

  for (const secret of ['ghp_never_backed_up', 'acme-account-key-text', 'restic-password-text']) {
    expect(texts).not.toContain(secret);
  }

  expect(texts).not.toContain('api-token-text');
  expect(texts).not.toContain('PRIVATE KEY');

  // the grant goes by name only
  const manifest = await ctx.readManifest(run.snapshotId);

  expect(manifest.imps[0]?.grants).toEqual(['gh']);
});

test('a restore regrants by name, and an unknown egress policy comes back open', async () => {
  await using ctx = await setupTest();

  await ctx.createDevImp();
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_value' });
  await ctx.broker.addSecret({ name: 'npm-old', kind: 'npm', value: 'npm_value' });
  await ctx.broker.addGrant('dev', 'gh');
  await ctx.broker.addGrant('dev', 'npm-old');

  // a policy from another impd version than this one knows
  await ctx.db.updateTable('imps').set({ egress_policy: 'granted-only' }).execute();
  await ctx.backups.runBackup();
  await ctx.broker.deleteSecret('npm-old');

  const result = await ctx.backups.restoreBackup({ name: 'dev', as: 'back' });
  const back = await findImpByName(ctx.db, 'back');
  const grants = await ctx.broker.listGrants('back');

  expect(grants).toEqual(['gh']);

  expect(result.skippedGrants.map((skip) => [skip.imp, skip.secret])).toEqual([
    ['back', 'npm-old'],
  ]);

  expect(result.skippedGrants[0]?.reason).toContain('npm-old');

  const row = await ctx.db
    .selectFrom('imps')
    .select('egress_policy')
    .where('id', '=', back?.id ?? '')
    .executeTakeFirst();

  expect(row?.egress_policy).toBe('open');

  expect(ctx.logs).toContain(
    'impd: backup: back: unknown egress policy "granted-only"; restored as open',
  );
});

test('a restore fetches one file at a time and leaves none behind', async () => {
  await using ctx = await setupTest();

  await ctx.createDevImp();

  const run = await ctx.backups.runBackup();
  const manifest = await ctx.readManifest(run.snapshotId);

  const [dev] = manifest.imps;

  ctx.fake.restores.length = 0;

  await ctx.backups.restoreBackup({ name: 'dev', as: 'copy' });

  expect(ctx.fake.restores).toEqual([
    ...(dev?.checkpoints ?? []).map((checkpoint) => dirname(checkpoint.disk)),
    dirname(dev?.disk ?? ''),
  ]);

  expect(readdirSync(join(ctx.dataDir, 'backup', 'restore'))).toEqual([]);
});

test('a manual run that succeeds ends the backoff of a failed scheduled run', async () => {
  await using ctx = await setupTest();

  ctx.fake.state.failBackup = true;

  await ctx.backups.runScheduled().catch(() => {});

  ctx.fake.state.failBackup = false;

  ctx.advance(60 * 1000);

  await ctx.backups.runBackup();

  // with the backoff left, the retry would be due 5 minutes after the failure
  ctx.fake.calls.length = 0;

  ctx.advance(5 * 60 * 1000);

  await ctx.backups.runScheduled();

  expect(ctx.fake.calls).toEqual([]);
});

test('a failed scheduled run waits twice as long each time, up to the interval', async () => {
  await using ctx = await setupTest();

  const MINUTE_MS = 60 * 1000;

  ctx.fake.state.failBackup = true;

  const tryRun = async (afterMs: number): Promise<boolean> => {
    ctx.advance(afterMs);

    const before = ctx.logs.length;

    await ctx.backups.runScheduled().catch(() => {});

    const calls = ctx.fake.calls.filter((call) => call === 'unlock').length;

    ctx.fake.calls.length = 0;

    return calls > 0 || ctx.logs.length > before;
  };

  // first failure, then 5, 10, 20 and 40 minutes, then the hour's interval;
  // after a success, the interval again
  const steps: [number, boolean][] = [
    [0, true],
    [4, false],
    [1, true],
    [9, false],
    [1, true],
    [20, true],
    [40, true],
    [59, false],
    [1, true],
  ];

  const seen: boolean[] = [];

  for (const [minutes] of steps) {
    const ran = await tryRun(minutes * MINUTE_MS);

    seen.push(ran);
  }

  ctx.fake.state.failBackup = false;

  for (const minutes of [60, 30]) {
    const ran = await tryRun(minutes * MINUTE_MS);

    seen.push(ran);
  }

  expect(seen).toEqual([...steps.map(([, ran]) => ran), true, false]);
});
