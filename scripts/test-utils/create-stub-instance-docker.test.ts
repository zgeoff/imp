import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubInstanceDocker } from './create-stub-instance-docker';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-stub-instance-docker-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it inspects a listed container', () => {
  const ctx = setupTest();
  const stub = createStubInstanceDocker(ctx.dir, { containers: ['imp-zfs'] });

  expect(
    Bun.spawnSync([join(stub.bin, 'docker'), 'container', 'inspect', 'imp-zfs']).exitCode,
  ).toBe(0);
});

test('it fails to inspect a container that is not listed, as Docker does', () => {
  const ctx = setupTest();
  const stub = createStubInstanceDocker(ctx.dir, { containers: ['imp-dev'] });
  const result = Bun.spawnSync([join(stub.bin, 'docker'), 'container', 'inspect', 'imp-zfs']);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'Error: No such container: imp-zfs\n',
  });
});

test('it fails to inspect any container when none is listed', () => {
  const ctx = setupTest();
  const stub = createStubInstanceDocker(ctx.dir, { containers: [] });

  expect(
    Bun.spawnSync([join(stub.bin, 'docker'), 'container', 'inspect', 'imp-zfs']).exitCode,
  ).toBe(1);
});

test('it succeeds any other command silently', () => {
  const ctx = setupTest();
  const stub = createStubInstanceDocker(ctx.dir, { containers: [] });
  const result = Bun.spawnSync([join(stub.bin, 'docker'), 'logs', 'imp-zfs']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '',
  });
});

test('it logs each call to the shared stub log', () => {
  const ctx = setupTest();
  const stub = createStubInstanceDocker(ctx.dir, { containers: [] });

  Bun.spawnSync([join(stub.bin, 'docker'), 'container', 'inspect', 'imp-zfs']);

  expect(readFileSync(stub.calls, 'utf8')).toBe('docker container inspect imp-zfs\n');
});
