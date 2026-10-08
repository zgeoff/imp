import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubDevDocker } from './build-stub-dev-docker';
import { createStubBin } from './create-stub-bin';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-dev-docker-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it lists each image as its tag and id', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevDocker([
      { tag: 'imp-host:dev-a-1', id: 'id-a', labels: null },
      { tag: 'imp-host:dev-b-2', id: 'id-b', labels: null },
    ]),
  );

  const result = Bun.spawnSync(
    ['docker', 'image', 'ls', '--filter', 'label=imp.worktree', '--format', '{{.Tag}}'],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe('imp-host:dev-a-1 id-a\nimp-host:dev-b-2 id-b\n');
});

test('it lists nothing when there are no images', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', buildStubDevDocker([]));

  const result = Bun.spawnSync(
    ['docker', 'image', 'ls', '--filter', 'label=imp.worktree', '--format', '{{.Tag}}'],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '',
  });
});

test('it answers an inspect with the worktree and machine labels, tab-separated', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevDocker([
      { tag: 'imp-host:dev-a-1', id: 'id-a', labels: { worktree: '/w/a b', machine: 'm1' } },
    ]),
  );

  const result = Bun.spawnSync(['docker', 'image', 'inspect', '-f', '{{x}}', 'id-a'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.stdout.toString()).toBe('/w/a b\tm1\n');
});

test('it fails an inspect of an image without labels', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevDocker([{ tag: 'imp-host:dev-a-1', id: 'id-a', labels: null }]),
  );

  const result = Bun.spawnSync(['docker', 'image', 'inspect', '-f', '{{x}}', 'id-a'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(1);
});

test('it answers ps with the container that uses an image, and nothing for another', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevDocker([
      { tag: 'imp-host:dev-a-1', id: 'id-a', labels: null, container: 'c0ffee' },
      { tag: 'imp-host:dev-b-2', id: 'id-b', labels: null },
    ]),
  );

  const result = Bun.spawnSync(
    ['bash', '-c', 'docker ps -aq --filter ancestor=id-a; docker ps -aq --filter ancestor=id-b'],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe('c0ffee\n');
});

test('it fails the rm of a stuck image and removes another', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevDocker([
      { tag: 'imp-host:dev-a-1', id: 'id-a', labels: null, isStuck: true },
      { tag: 'imp-host:dev-b-2', id: 'id-b', labels: null },
    ]),
  );

  const env = { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` };
  const stuck = Bun.spawnSync(['docker', 'image', 'rm', 'imp-host:dev-a-1'], { env });
  const removed = Bun.spawnSync(['docker', 'image', 'rm', 'imp-host:dev-b-2'], { env });

  expect(stuck.exitCode).toBe(1);
  expect(removed.exitCode).toBe(0);
});

test('it fails a call that prune does not make', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', buildStubDevDocker([]));

  const result = Bun.spawnSync(['docker', 'run', 'busybox'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(1);
});
