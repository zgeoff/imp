import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWipeTarget } from './wipe-target';
import { ZFS_OWNER_FILE } from './zfs-owner';

// a repo root with its .data
async function setupTest() {
  const root = await mkdtemp(join(tmpdir(), 'wipe-target-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const repoRoot = join(root, 'repo');

  await mkdir(join(repoRoot, '.data'), { recursive: true });

  return { root, repoRoot };
}

// a zpool status that answers with stdout
function createZfsRunner(stdout: string) {
  return () => Promise.resolve({ exitCode: 0, stdout, stderr: '' });
}

test('it gives nothing to wipe for a data dir that does not exist', async () => {
  const ctx = await setupTest();

  const target = await resolveWipeTarget({
    path: join(ctx.repoRoot, '.data', 'dev'),
    repoRoot: ctx.repoRoot,
    storageBackend: undefined,
    zfsRoot: undefined,
    run: createZfsRunner(''),
  });

  expect(target).toBeNull();
});

test('it wipes a data dir under the repo’s .data', async () => {
  const ctx = await setupTest();

  const dir = join(ctx.repoRoot, '.data', 'dev');

  await mkdir(dir);

  const target = await resolveWipeTarget({
    path: dir,
    repoRoot: ctx.repoRoot,
    storageBackend: undefined,
    zfsRoot: undefined,
    run: createZfsRunner(''),
  });

  expect(target).toStrictEqual({ dir, zfs: null });
});

test('it wipes a data dir elsewhere that holds an imp.xfs', async () => {
  const ctx = await setupTest();

  const dir = join(ctx.root, 'ci');

  await mkdir(dir);
  await writeFile(join(dir, 'imp.xfs'), '');

  const target = await resolveWipeTarget({
    path: dir,
    repoRoot: ctx.repoRoot,
    storageBackend: undefined,
    zfsRoot: undefined,
    run: createZfsRunner(''),
  });

  expect(target).toStrictEqual({ dir, zfs: null });
});

test('it refuses a data dir elsewhere with no imp.xfs and no ZFS proof', async () => {
  const ctx = await setupTest();

  const dir = join(ctx.root, 'home');

  await mkdir(dir);

  const attempt = resolveWipeTarget({
    path: dir,
    repoRoot: ctx.repoRoot,
    storageBackend: 'zfs',
    zfsRoot: 'impbench7/imp',
    run: createZfsRunner(''),
  });

  await Promise.allSettled([attempt]);

  expect(attempt).rejects.toThrow(`refusing to wipe ${dir}: it is not under`);
});

test('it empties the proven ZFS root of a data dir outside the repo', async () => {
  const ctx = await setupTest();

  const dir = join(ctx.root, 'data');
  const vdev = join(ctx.root, 'bench.img');

  await mkdir(dir);

  await writeFile(
    join(dir, ZFS_OWNER_FILE),
    JSON.stringify({ pool: 'impbench7', root: 'impbench7/imp', vdev }),
  );

  const target = await resolveWipeTarget({
    path: dir,
    repoRoot: ctx.repoRoot,
    storageBackend: 'zfs',
    zfsRoot: 'impbench7/imp',
    run: createZfsRunner(`\t${vdev}  ONLINE  0 0 0\n`),
  });

  expect(target).toStrictEqual({
    dir,
    zfs: { pool: 'impbench7', root: 'impbench7/imp', vdev },
  });
});

test('it empties the proven ZFS root of a data dir under the repo’s .data too', async () => {
  const ctx = await setupTest();

  const dir = join(ctx.repoRoot, '.data', 'zfs', 'data');
  const vdev = join(ctx.repoRoot, '.data', 'zfs', 'bench.img');

  await mkdir(dir, { recursive: true });

  await writeFile(
    join(dir, ZFS_OWNER_FILE),
    JSON.stringify({ pool: 'impbench7', root: 'impbench7/imp', vdev }),
  );

  const target = await resolveWipeTarget({
    path: dir,
    repoRoot: ctx.repoRoot,
    storageBackend: 'zfs',
    zfsRoot: 'impbench7/imp',
    run: createZfsRunner(`\t${vdev}  ONLINE  0 0 0\n`),
  });

  expect(target).toStrictEqual({
    dir,
    zfs: { pool: 'impbench7', root: 'impbench7/imp', vdev },
  });
});
