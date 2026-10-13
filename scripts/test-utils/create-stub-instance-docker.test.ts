import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('it fails to inspect a container started later until its marker exists', () => {
  const ctx = setupTest();
  const marker = join(ctx.dir, 'started');

  const stub = createStubInstanceDocker(ctx.dir, {
    containers: [],
    startedLater: { marker, containers: ['imp-zfs-mv-b'] },
  });

  expect(
    Bun.spawnSync([join(stub.bin, 'docker'), 'container', 'inspect', 'imp-zfs-mv-b']).exitCode,
  ).toBe(1);
});

test('it inspects a container started later once its marker exists', () => {
  const ctx = setupTest();
  const marker = join(ctx.dir, 'started');

  const stub = createStubInstanceDocker(ctx.dir, {
    containers: [],
    startedLater: { marker, containers: ['imp-zfs-mv-b'] },
  });

  writeFileSync(marker, '');

  expect(
    Bun.spawnSync([join(stub.bin, 'docker'), 'container', 'inspect', 'imp-zfs-mv-b']).exitCode,
  ).toBe(0);
});

test('it inspects a listed network', () => {
  const ctx = setupTest();
  const stub = createStubInstanceDocker(ctx.dir, { containers: [], networks: ['imp-zfs-mv'] });

  expect(
    Bun.spawnSync([join(stub.bin, 'docker'), 'network', 'inspect', 'imp-zfs-mv']).exitCode,
  ).toBe(0);
});

test('it fails to inspect a network that is not listed, as Docker does', () => {
  const ctx = setupTest();
  const stub = createStubInstanceDocker(ctx.dir, { containers: ['imp-zfs-mv'] });
  const result = Bun.spawnSync([join(stub.bin, 'docker'), 'network', 'inspect', 'imp-zfs-mv']);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'Error response from daemon: network imp-zfs-mv not found\n',
  });
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
