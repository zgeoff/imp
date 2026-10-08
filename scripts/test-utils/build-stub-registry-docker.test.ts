import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubRegistryDocker } from './build-stub-registry-docker';
import { createStubBin } from './create-stub-bin';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-registry-docker-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test('it fails an inspect of a missing tag with buildx’s not-found error', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', buildStubRegistryDocker({ kind: 'missing' }));

  const result = Bun.spawnSync(
    ['docker', 'buildx', 'imagetools', 'inspect', 'ghcr.io/a/b:1', '--format', '{{x}}'],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'ERROR: ghcr.io/a/b:1: not found\n',
  });
});

test('it prints what the registry has for a found tag', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubRegistryDocker({ kind: 'found', stdout: 'WARN: x\nsha256:abc' }),
  );

  const result = Bun.spawnSync(
    ['docker', 'buildx', 'imagetools', 'inspect', 'ghcr.io/a/b:1', '--format', '{{x}}'],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'WARN: x\nsha256:abc\n',
  });
});

test('it fails an inspect with the registry’s error on stderr', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubRegistryDocker({ kind: 'failed', error: "ERROR: it's 403 Forbidden" }),
  );

  const result = Bun.spawnSync(
    ['docker', 'buildx', 'imagetools', 'inspect', 'ghcr.io/a/b:1', '--format', '{{x}}'],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: "ERROR: it's 403 Forbidden\n",
  });
});

test('it fails a call that is not an imagetools inspect', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubRegistryDocker({ kind: 'found', stdout: 'sha256:abc' }),
  );

  const result = Bun.spawnSync(['docker', 'pull', 'ghcr.io/a/b:1'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 1,
    stdout: '',
  });
});
