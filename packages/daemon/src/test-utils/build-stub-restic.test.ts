import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubRestic } from './build-stub-restic';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'stub-restic-test-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const repoDir = join(dir, 'repo');
  const treeDir = join(dir, 'tree');

  mkdirSync(repoDir);
  mkdirSync(join(treeDir, 'imps', 'i1'), { recursive: true });

  return { dir, repoDir, treeDir };
}

test('it lists a backup with its time, its dir and impd’s tag before the given ones', async () => {
  const ctx = setupTest();

  const restic = buildStubRestic({
    repoDir: ctx.repoDir,
    now: () => new Date('2026-10-02T00:00:00Z'),
  });

  writeFileSync(join(ctx.treeDir, 'manifest.json'), '{}');

  const summary = await restic.restic.backup(ctx.treeDir, ['run=r1']);
  const snapshots = await restic.restic.listSnapshots();

  expect(summary).toStrictEqual({
    snapshotId: 'snap1',
    filesNew: 0,
    filesChanged: 0,
    filesUnmodified: 0,
    dataAddedBytes: 10,
  });

  expect(snapshots).toStrictEqual([
    {
      id: 'snap1',
      time: new Date('2026-10-02T00:00:00Z'),
      paths: [ctx.treeDir],
      tags: ['imp-backup', 'run=r1'],
    },
  ]);
});

test('it shares the snapshots with another stub over the same repository, oldest first', async () => {
  const ctx = setupTest();

  const first = buildStubRestic({
    repoDir: ctx.repoDir,
    now: () => new Date('2026-10-02T06:00:00Z'),
  });

  const second = buildStubRestic({
    repoDir: ctx.repoDir,
    now: () => new Date('2026-10-02T00:00:00Z'),
  });

  await first.restic.backup(ctx.treeDir, []);
  await second.restic.backup(ctx.treeDir, []);

  const snapshots = await second.restic.listSnapshots();

  expect(snapshots.map((snapshot) => snapshot.id)).toStrictEqual(['snap2', 'snap1']);
});

test('it dumps a file of a snapshot as it was at the backup', async () => {
  const ctx = setupTest();
  const restic = buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date() });

  writeFileSync(join(ctx.treeDir, 'manifest.json'), 'then');

  const summary = await restic.restic.backup(ctx.treeDir, []);

  writeFileSync(join(ctx.treeDir, 'manifest.json'), 'now');

  const text = await restic.restic.dump(summary.snapshotId, join(ctx.treeDir, 'manifest.json'));

  expect(text).toBe('then');
});

test('it restores a snapshot’s dir into the target and records it', async () => {
  const ctx = setupTest();
  const restic = buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date() });

  writeFileSync(join(ctx.treeDir, 'imps', 'i1', 'disk.ext4'), 'disk');

  const summary = await restic.restic.backup(ctx.treeDir, []);

  const hooked: string[] = [];

  restic.state.onRestore = (dir) => {
    hooked.push(dir);

    return Promise.resolve();
  };

  await restic.restic.restore(
    summary.snapshotId,
    join(ctx.treeDir, 'imps', 'i1'),
    join(ctx.dir, 'out'),
    [],
  );

  expect(readFileSync(join(ctx.dir, 'out', 'disk.ext4'), 'utf8')).toBe('disk');
  expect(restic.restores).toStrictEqual(['imps/i1']);
  expect(hooked).toStrictEqual(['imps/i1']);
});

test('it refuses a restore with include patterns', async () => {
  const ctx = setupTest();
  const restic = buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date() });

  const summary = await restic.restic.backup(ctx.treeDir, []);

  expect(
    restic.restic.restore(summary.snapshotId, ctx.treeDir, join(ctx.dir, 'out'), ['/imps/i1']),
  ).rejects.toThrow('the stub restic restores whole dirs, without includes');
});

test('it rejects a restore of a snapshot that is not there as NOT_FOUND', () => {
  const ctx = setupTest();
  const restic = buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date() });

  expect(
    restic.restic.restore('snap9', ctx.treeDir, join(ctx.dir, 'out'), []),
  ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'backup snap9 not found' });
});

test('it rejects a dump of a snapshot that is not there as NOT_FOUND', () => {
  const ctx = setupTest();
  const restic = buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date() });

  expect(restic.restic.dump('snap9', join(ctx.treeDir, 'manifest.json'))).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: 'backup snap9 not found',
  });
});

test('it fails a backup when the test sets failBackup, and lists nothing', async () => {
  const ctx = setupTest();
  const restic = buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date() });

  restic.state.failBackup = true;

  expect(restic.restic.backup(ctx.treeDir, [])).rejects.toThrow(
    'Fatal: unable to save snapshot: bucket full',
  );

  const snapshots = await restic.restic.listSnapshots();

  expect(snapshots).toStrictEqual([]);
});

test('it fails a check when the test sets failCheck', () => {
  const ctx = setupTest();
  const restic = buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date() });

  restic.state.failCheck = true;

  expect(restic.restic.check('1/5')).rejects.toThrow(
    'Fatal: pack 9f2c: ciphertext verification failed',
  );
});

test('it fails each prune with the next queued error, in order', () => {
  const ctx = setupTest();
  const restic = buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date() });

  restic.state.pruneErrors.push(new Error('locked'), new Error('bucket full'));

  expect(restic.restic.prune()).rejects.toThrow('locked');
  expect(restic.restic.prune()).rejects.toThrow('bucket full');
});

test('it records the repository commands in order', async () => {
  const ctx = setupTest();
  const restic = buildStubRestic({ repoDir: ctx.repoDir, now: () => new Date() });

  await restic.restic.unlock();
  await restic.restic.backup(ctx.treeDir, []);
  await restic.restic.forget({ hourly: 1, daily: 0, weekly: 0 });
  await restic.restic.prune();
  await restic.restic.check('1/5');

  expect(restic.calls).toStrictEqual(['unlock', 'backup', 'forget', 'prune', 'check']);
});
