import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZFS_OWNER_FILE, readZfsOwner, resetZfsRoot } from './zfs-owner';

// a work dir as scripts/zfs-host-test.sh leaves it: data beside bench.img
async function setupTest() {
  const work = await mkdtemp(join(tmpdir(), 'zfs-owner-'));

  onTestFinished(() => rm(work, { recursive: true, force: true }));

  const dataDir = join(work, 'data');

  await mkdir(dataDir);

  const calls: string[] = [];

  // a zpool or zfs that logs each call and answers with stdout
  const createZfsRunner =
    (stdout: string, exitCode = 0) =>
    (argv: readonly string[]) => {
      calls.push(argv.join(' '));

      return Promise.resolve({ exitCode, stdout, stderr: '' });
    };

  return { work, dataDir, vdev: join(work, 'bench.img'), calls, createZfsRunner };
}

test('#readZfsOwner proves a data dir whose pool lists its vdev', async () => {
  const ctx = await setupTest();

  await writeFile(
    join(ctx.dataDir, ZFS_OWNER_FILE),
    JSON.stringify({ pool: 'impbench7', root: 'impbench7/imp', vdev: ctx.vdev }),
  );

  const owner = await readZfsOwner({
    dataDir: ctx.dataDir,
    zfsRoot: 'impbench7/imp',
    run: ctx.createZfsRunner(`  pool: impbench7\n config:\n\t${ctx.vdev}  ONLINE  0 0 0\n`),
  });

  expect(owner).toStrictEqual({ pool: 'impbench7', root: 'impbench7/imp', vdev: ctx.vdev });
  expect(ctx.calls).toStrictEqual(['zpool status -P impbench7']);
});

test('#readZfsOwner proves nothing for a data dir with no owner file', async () => {
  const ctx = await setupTest();

  const owner = await readZfsOwner({
    dataDir: ctx.dataDir,
    zfsRoot: 'impbench7/imp',
    run: ctx.createZfsRunner(''),
  });

  expect(owner).toBeNull();
  expect(ctx.calls).toBeEmpty();
});

test('#readZfsOwner proves nothing when the owner file does not parse', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.dataDir, ZFS_OWNER_FILE), '{"pool":');

  const owner = await readZfsOwner({
    dataDir: ctx.dataDir,
    zfsRoot: 'impbench7/imp',
    run: ctx.createZfsRunner(''),
  });

  expect(owner).toBeNull();
});

test('#readZfsOwner proves nothing when the root is not this run’s IMP_ZFS_ROOT', async () => {
  const ctx = await setupTest();

  await writeFile(
    join(ctx.dataDir, ZFS_OWNER_FILE),
    JSON.stringify({ pool: 'impbench7', root: 'impbench7/imp', vdev: ctx.vdev }),
  );

  const owner = await readZfsOwner({
    dataDir: ctx.dataDir,
    zfsRoot: 'tank/imp',
    run: ctx.createZfsRunner(`\t${ctx.vdev}  ONLINE\n`),
  });

  expect(owner).toBeNull();
  expect(ctx.calls).toBeEmpty();
});

test('#readZfsOwner proves nothing when the root sits outside the pool', async () => {
  const ctx = await setupTest();

  await writeFile(
    join(ctx.dataDir, ZFS_OWNER_FILE),
    JSON.stringify({ pool: 'impbench7', root: 'tank/imp', vdev: ctx.vdev }),
  );

  const owner = await readZfsOwner({
    dataDir: ctx.dataDir,
    zfsRoot: 'tank/imp',
    run: ctx.createZfsRunner(`\t${ctx.vdev}  ONLINE\n`),
  });

  expect(owner).toBeNull();
});

test('#readZfsOwner proves nothing when the vdev does not sit beside the data dir', async () => {
  const ctx = await setupTest();

  const elsewhere = join(tmpdir(), 'bench.img');

  await writeFile(
    join(ctx.dataDir, ZFS_OWNER_FILE),
    JSON.stringify({ pool: 'impbench7', root: 'impbench7/imp', vdev: elsewhere }),
  );

  const owner = await readZfsOwner({
    dataDir: ctx.dataDir,
    zfsRoot: 'impbench7/imp',
    run: ctx.createZfsRunner(`\t${elsewhere}  ONLINE\n`),
  });

  expect(owner).toBeNull();
  expect(ctx.calls).toBeEmpty();
});

test('#readZfsOwner proves nothing when the pool does not list the vdev', async () => {
  const ctx = await setupTest();

  await writeFile(
    join(ctx.dataDir, ZFS_OWNER_FILE),
    JSON.stringify({ pool: 'impbench7', root: 'impbench7/imp', vdev: ctx.vdev }),
  );

  const owner = await readZfsOwner({
    dataDir: ctx.dataDir,
    zfsRoot: 'impbench7/imp',
    run: ctx.createZfsRunner('  pool: impbench7\n\t/dev/sdb  ONLINE  0 0 0\n'),
  });

  expect(owner).toBeNull();
});

test('#readZfsOwner proves nothing when the pool is not there', async () => {
  const ctx = await setupTest();

  await writeFile(
    join(ctx.dataDir, ZFS_OWNER_FILE),
    JSON.stringify({ pool: 'impbench7', root: 'impbench7/imp', vdev: ctx.vdev }),
  );

  const owner = await readZfsOwner({
    dataDir: ctx.dataDir,
    zfsRoot: 'impbench7/imp',
    run: ctx.createZfsRunner('', 1),
  });

  expect(owner).toBeNull();
});

test('#resetZfsRoot destroys the root with all under it, then makes it again', async () => {
  const ctx = await setupTest();

  await resetZfsRoot(
    { pool: 'impbench7', root: 'impbench7/imp', vdev: ctx.vdev },
    ctx.createZfsRunner(''),
  );

  expect(ctx.calls).toStrictEqual([
    'zfs destroy -R impbench7/imp',
    'zfs create -o mountpoint=legacy impbench7/imp',
  ]);
});

test('#resetZfsRoot rejects when the destroy fails', async () => {
  const ctx = await setupTest();

  const run = (argv: readonly string[]) => {
    ctx.calls.push(argv.join(' '));

    return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'dataset is busy\n' });
  };

  const attempt = resetZfsRoot({ pool: 'impbench7', root: 'impbench7/imp', vdev: ctx.vdev }, run);

  await Promise.allSettled([attempt]);

  expect(attempt).rejects.toThrow('zfs destroy -R impbench7/imp exited 1: dataset is busy');
  expect(ctx.calls).toStrictEqual(['zfs destroy -R impbench7/imp']);
});
