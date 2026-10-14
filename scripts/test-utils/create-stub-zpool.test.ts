import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@imp/test-utils/wait-for';
import { createStubZpool } from './create-stub-zpool';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-stub-zpool-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it lists no pool before a create', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir);

  expect(Bun.spawnSync([join(stub.bin, 'zpool'), 'list', 'tank']).exitCode).toBe(1);
});

test('it lists a created pool', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir);

  Bun.spawnSync([join(stub.bin, 'zpool'), 'create', '-O', 'atime=off', 'tank', '/work/pool.img']);

  expect(Bun.spawnSync([join(stub.bin, 'zpool'), 'list', 'tank']).exitCode).toBe(0);
});

test('it shows the vdev of a created pool in status -P', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir);

  Bun.spawnSync([join(stub.bin, 'zpool'), 'create', '-O', 'atime=off', 'tank', '/work/pool.img']);

  const result = Bun.spawnSync([join(stub.bin, 'zpool'), 'status', '-P', 'tank']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '  pool: tank\n\t  /work/pool.img  ONLINE  0 0 0\n',
  });
});

test('it shows every pool in status -P with no pool named', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir);

  Bun.spawnSync([join(stub.bin, 'zpool'), 'create', 'tank', '/work/a.img']);
  Bun.spawnSync([join(stub.bin, 'zpool'), 'create', 'bench', '/work/b.img']);

  expect(Bun.spawnSync([join(stub.bin, 'zpool'), 'status', '-P']).stdout.toString()).toBe(
    '  pool: tank\n\t  /work/a.img  ONLINE  0 0 0\n  pool: bench\n\t  /work/b.img  ONLINE  0 0 0\n',
  );
});

test('it forgets a destroyed pool', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir);

  Bun.spawnSync([join(stub.bin, 'zpool'), 'create', 'tank', '/work/pool.img']);
  Bun.spawnSync([join(stub.bin, 'zpool'), 'destroy', '-f', 'tank']);

  expect(Bun.spawnSync([join(stub.bin, 'zpool'), 'list', 'tank']).exitCode).toBe(1);
});

test('it fails a create when told to', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir, { create: 'fails' });
  const result = Bun.spawnSync([join(stub.bin, 'zpool'), 'create', 'tank', '/work/pool.img']);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'pool already exists\n',
  });
});

test('it makes no pool when a create fails', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir, { create: 'fails' });

  Bun.spawnSync([join(stub.bin, 'zpool'), 'create', 'tank', '/work/pool.img']);

  expect(Bun.spawnSync([join(stub.bin, 'zpool'), 'list', 'tank']).exitCode).toBe(1);
});

test('it marks a held create as started and makes no pool before the release', async () => {
  const ctx = setupTest();
  const startedMarker = join(ctx.dir, 'started');
  const release = join(ctx.dir, 'release');
  const stub = createStubZpool(ctx.dir, { create: { startedMarker, release } });
  const create = Bun.spawn([join(stub.bin, 'zpool'), 'create', 'tank', '/work/pool.img']);

  onTestFinished(async () => {
    create.kill('SIGKILL');

    await create.exited;
  });

  await waitFor(() => readFileSync(startedMarker), { timeoutMs: 10_000 });

  expect(Bun.spawnSync([join(stub.bin, 'zpool'), 'list', 'tank']).exitCode).toBe(1);
});

test('it makes the pool of a held create once released', async () => {
  const ctx = setupTest();
  const startedMarker = join(ctx.dir, 'started');
  const release = join(ctx.dir, 'release');
  const stub = createStubZpool(ctx.dir, { create: { startedMarker, release } });
  const create = Bun.spawn([join(stub.bin, 'zpool'), 'create', 'tank', '/work/pool.img']);

  onTestFinished(async () => {
    create.kill('SIGKILL');

    await create.exited;
  });

  await waitFor(() => readFileSync(startedMarker), { timeoutMs: 10_000 });

  writeFileSync(release, '');

  const exitCode = await create.exited;

  expect(exitCode).toBe(0);
  expect(Bun.spawnSync([join(stub.bin, 'zpool'), 'list', 'tank']).exitCode).toBe(0);
});

test.each([
  ['fails', 1],
  ['busy', 1],
  ['ignored', 0],
] as const)('it answers a destroy that is %s with exit code %d', (destroy, exitCode) => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir, { destroy });

  Bun.spawnSync([join(stub.bin, 'zpool'), 'create', 'tank', '/work/pool.img']);

  expect(Bun.spawnSync([join(stub.bin, 'zpool'), 'destroy', '-f', 'tank']).exitCode).toBe(exitCode);
});

test('it says the pool is busy when a busy destroy fails', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir, { destroy: 'busy' });

  Bun.spawnSync([join(stub.bin, 'zpool'), 'create', 'tank', '/work/pool.img']);

  expect(Bun.spawnSync([join(stub.bin, 'zpool'), 'destroy', '-f', 'tank']).stderr.toString()).toBe(
    "cannot destroy 'tank': pool is busy\n",
  );
});

test.each([['fails'], ['busy'], ['ignored']] as const)(
  'it keeps the pool when a destroy is %s',
  (destroy) => {
    const ctx = setupTest();
    const stub = createStubZpool(ctx.dir, { destroy });

    Bun.spawnSync([join(stub.bin, 'zpool'), 'create', 'tank', '/work/pool.img']);
    Bun.spawnSync([join(stub.bin, 'zpool'), 'destroy', '-f', 'tank']);

    expect(Bun.spawnSync([join(stub.bin, 'zpool'), 'list', 'tank']).exitCode).toBe(0);
  },
);

test('it logs each call to the shared stub log', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir);

  Bun.spawnSync([join(stub.bin, 'zpool'), 'list', 'tank']);

  expect(readFileSync(stub.calls, 'utf8')).toBe('zpool list tank\n');
});

test('it names every pool in list -H -o name', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir);

  Bun.spawnSync([join(stub.bin, 'zpool'), 'create', 'tank', '/work dir/a.img']);
  Bun.spawnSync([join(stub.bin, 'zpool'), 'create', 'bench', '/work dir/b.img']);

  const result = Bun.spawnSync([join(stub.bin, 'zpool'), 'list', '-H', '-o', 'name']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'tank\nbench\n',
  });
});

test('it keeps a vdev path with spaces whole in status -P', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir);

  Bun.spawnSync([join(stub.bin, 'zpool'), 'create', 'tank', '/work dir/pool.img']);

  expect(Bun.spawnSync([join(stub.bin, 'zpool'), 'status', '-P', 'tank']).stdout.toString()).toBe(
    '  pool: tank\n\t  /work dir/pool.img  ONLINE  0 0 0\n',
  );
});

test('it fails status for a pool that is not there', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir);

  expect(Bun.spawnSync([join(stub.bin, 'zpool'), 'status', '-P', 'tank']).exitCode).toBe(1);
});

test('it fails list -H once a pool exists, when told to', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir, { queries: 'fail' });

  Bun.spawnSync([join(stub.bin, 'zpool'), 'create', 'tank', '/work/pool.img']);

  expect(Bun.spawnSync([join(stub.bin, 'zpool'), 'list', '-H', '-o', 'name']).exitCode).toBe(1);
});

test('it fails status once a pool exists, when told to', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir, { queries: 'fail' });

  Bun.spawnSync([join(stub.bin, 'zpool'), 'create', 'tank', '/work/pool.img']);

  expect(Bun.spawnSync([join(stub.bin, 'zpool'), 'status', '-P']).exitCode).toBe(1);
});

test('it still answers list for a named pool when queries fail', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir, { queries: 'fail' });

  Bun.spawnSync([join(stub.bin, 'zpool'), 'create', 'tank', '/work/pool.img']);

  expect(Bun.spawnSync([join(stub.bin, 'zpool'), 'list', 'tank']).exitCode).toBe(0);
});
