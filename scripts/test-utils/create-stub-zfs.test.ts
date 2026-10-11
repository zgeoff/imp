import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubZfs } from './create-stub-zfs';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-stub-zfs-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it prints the userland and module versions for version', () => {
  const ctx = setupTest();
  const stub = createStubZfs(ctx.dir);
  const result = Bun.spawnSync([join(stub.bin, 'zfs'), 'version']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'zfs-2.3.4-1\nzfs-kmod-2.3.4-1\n',
  });
});

test('it succeeds a create silently', () => {
  const ctx = setupTest();
  const stub = createStubZfs(ctx.dir);

  const result = Bun.spawnSync([
    join(stub.bin, 'zfs'),
    'create',
    '-o',
    'mountpoint=legacy',
    'tank/imp',
  ]);

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('it fails a create when told to', () => {
  const ctx = setupTest();
  const stub = createStubZfs(ctx.dir, { create: 'fails' });

  const result = Bun.spawnSync([
    join(stub.bin, 'zfs'),
    'create',
    '-o',
    'mountpoint=legacy',
    'tank/imp',
  ]);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'cannot create dataset\n',
  });
});

test('it prints the version when only a create fails', () => {
  const ctx = setupTest();
  const stub = createStubZfs(ctx.dir, { create: 'fails' });

  expect(Bun.spawnSync([join(stub.bin, 'zfs'), 'version']).stdout.toString()).toBe(
    'zfs-2.3.4-1\nzfs-kmod-2.3.4-1\n',
  );
});

test('it succeeds any other command silently', () => {
  const ctx = setupTest();
  const stub = createStubZfs(ctx.dir);
  const result = Bun.spawnSync([join(stub.bin, 'zfs'), 'list', '-r', 'tank']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '',
  });
});

test('it logs each call to the shared stub log', () => {
  const ctx = setupTest();
  const stub = createStubZfs(ctx.dir);

  Bun.spawnSync([join(stub.bin, 'zfs'), 'version']);

  expect(readFileSync(stub.calls, 'utf8')).toBe('zfs version\n');
});
