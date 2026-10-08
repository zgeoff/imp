import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubZpool } from './create-stub-zpool';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-stub-zpool-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

function runZpool(bin: string, ...args: readonly string[]) {
  const result = Bun.spawnSync(['zpool', ...args], {
    env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` },
  });

  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

test('it lists no pool before a create', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir);

  expect(runZpool(stub.bin, 'list', 'tank').exitCode).toBe(1);
});

test('it lists a created pool and shows its vdev in status -P', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir);

  runZpool(stub.bin, 'create', '-O', 'atime=off', 'tank', '/work/pool.img');

  expect(runZpool(stub.bin, 'list', 'tank').exitCode).toBe(0);

  expect(runZpool(stub.bin, 'status', '-P', 'tank')).toStrictEqual({
    exitCode: 0,
    stdout: '  pool: tank\n\t  /work/pool.img  ONLINE  0 0 0\n',
  });
});

test('it shows every pool in status -P with no pool named', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir);

  runZpool(stub.bin, 'create', 'tank', '/work/a.img');
  runZpool(stub.bin, 'create', 'bench', '/work/b.img');

  expect(runZpool(stub.bin, 'status', '-P').stdout).toBe(
    '  pool: tank\n\t  /work/a.img  ONLINE  0 0 0\n  pool: bench\n\t  /work/b.img  ONLINE  0 0 0\n',
  );
});

test('it forgets a destroyed pool', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir);

  runZpool(stub.bin, 'create', 'tank', '/work/pool.img');
  runZpool(stub.bin, 'destroy', '-f', 'tank');

  expect(runZpool(stub.bin, 'list', 'tank').exitCode).toBe(1);
});

test('it fails a create, and makes no pool, when told to', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir, { create: 'fails' });

  expect(runZpool(stub.bin, 'create', 'tank', '/work/pool.img').exitCode).toBe(1);
  expect(runZpool(stub.bin, 'list', 'tank').exitCode).toBe(1);
});

test('it marks a slow create as started before the pool exists', () => {
  const ctx = setupTest();
  const startedMarker = join(ctx.dir, 'started');
  const stub = createStubZpool(ctx.dir, { create: { startedMarker } });

  runZpool(stub.bin, 'create', 'tank', '/work/pool.img');

  expect(existsSync(startedMarker)).toBeTrue();
  expect(runZpool(stub.bin, 'list', 'tank').exitCode).toBe(0);
});

test.each([
  ['fails', 1],
  ['ignored', 0],
] as const)('it keeps the pool when a destroy is %s', (destroy, exitCode) => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir, { destroy });

  runZpool(stub.bin, 'create', 'tank', '/work/pool.img');

  expect(runZpool(stub.bin, 'destroy', '-f', 'tank').exitCode).toBe(exitCode);
  expect(runZpool(stub.bin, 'list', 'tank').exitCode).toBe(0);
});

test('it logs each call to the shared stub log', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir);

  runZpool(stub.bin, 'list', 'tank');

  expect(readFileSync(stub.calls, 'utf8')).toBe('zpool list tank\n');
});

test('it names every pool in list -H -o name', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir);

  runZpool(stub.bin, 'create', 'tank', '/work dir/a.img');
  runZpool(stub.bin, 'create', 'bench', '/work dir/b.img');

  expect(runZpool(stub.bin, 'list', '-H', '-o', 'name')).toStrictEqual({
    exitCode: 0,
    stdout: 'tank\nbench\n',
  });
});

test('it keeps a vdev path with spaces whole in status -P', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir);

  runZpool(stub.bin, 'create', 'tank', '/work dir/pool.img');

  expect(runZpool(stub.bin, 'status', '-P', 'tank').stdout).toBe(
    '  pool: tank\n\t  /work dir/pool.img  ONLINE  0 0 0\n',
  );
});

test('it fails status for a pool that is not there', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir);

  expect(runZpool(stub.bin, 'status', '-P', 'tank').exitCode).toBe(1);
});

test('it fails list -H and status once a pool exists, when told to', () => {
  const ctx = setupTest();
  const stub = createStubZpool(ctx.dir, { queries: 'fail' });

  runZpool(stub.bin, 'create', 'tank', '/work/pool.img');

  expect(runZpool(stub.bin, 'list', '-H', '-o', 'name').exitCode).toBe(1);
  expect(runZpool(stub.bin, 'status', '-P').exitCode).toBe(1);
  expect(runZpool(stub.bin, 'list', 'tank').exitCode).toBe(0);
});
