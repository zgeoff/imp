import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubDockerBin } from './create-stub-docker-bin';

// a directory for the stub
async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'stub-docker-bin-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it answers the version as an amd64 engine on linux', async () => {
  const ctx = await setupTest();

  const docker = createStubDockerBin(ctx.dir, {});

  const run = Bun.spawnSync([
    join(docker.binDir, 'docker'),
    'version',
    '--format',
    '{{json .Server.Os}} {{json .Server.Arch}}',
  ]);

  expect(run.stdout.toString()).toBe('"linux" "amd64"\n');
});

test('it has the Dockerfile frontend', async () => {
  const ctx = await setupTest();

  const docker = createStubDockerBin(ctx.dir, {});

  const run = Bun.spawnSync([
    join(docker.binDir, 'docker'),
    'image',
    'inspect',
    '--format',
    '{{.Id}}',
    'docker/dockerfile:1.12',
  ]);

  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).toBe(`sha256:${'f'.repeat(64)}\n`);
});

test('it inspects an image it has by reference', async () => {
  const ctx = await setupTest();

  const docker = createStubDockerBin(ctx.dir, {
    'imp/web:latest': {
      id: `sha256:${'b'.repeat(64)}`,
      repoDigests: ['imp/web@sha256:abc'],
      files: {},
    },
  });

  const run = Bun.spawnSync([join(docker.binDir, 'docker'), 'image', 'inspect', 'imp/web:latest']);
  const inspect: unknown = JSON.parse(run.stdout.toString());

  expect(inspect).toStrictEqual([
    { Id: `sha256:${'b'.repeat(64)}`, Config: {}, Size: 1024, RepoDigests: ['imp/web@sha256:abc'] },
  ]);
});

test('it exports the files of a container made from an image', async () => {
  const ctx = await setupTest();

  const docker = createStubDockerBin(ctx.dir, {
    'imp/web:latest': { id: `sha256:${'b'.repeat(64)}`, repoDigests: [], files: { hello: 'hi\n' } },
  });

  const created = Bun.spawnSync([
    join(docker.binDir, 'docker'),
    'create',
    'imp/web:latest',
    '/bin/true',
  ]);

  const container = created.stdout.toString().trim();
  const exported = Bun.spawnSync([join(docker.binDir, 'docker'), 'export', container]);
  const hello = Bun.spawnSync(['tar', '-xO', '-f', '-', './hello'], { stdin: exported.stdout });

  expect(hello.stdout.toString()).toBe('hi\n');
});

test('it removes a container', async () => {
  const ctx = await setupTest();

  const docker = createStubDockerBin(ctx.dir, {});
  const run = Bun.spawnSync([join(docker.binDir, 'docker'), 'rm', '-f', 'abc']);

  expect(run.exitCode).toBe(0);
});

test('it fails a call it lacks and names it', async () => {
  const ctx = await setupTest();

  const docker = createStubDockerBin(ctx.dir, {});
  const run = Bun.spawnSync([join(docker.binDir, 'docker'), 'pull', '--quiet', 'busybox:1.37']);

  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toBe('the stub docker has no pull --quiet busybox:1.37\n');
});

test('it fails an inspect of an image it lacks', async () => {
  const ctx = await setupTest();

  const docker = createStubDockerBin(ctx.dir, {});
  const run = Bun.spawnSync([join(docker.binDir, 'docker'), 'image', 'inspect', 'busybox:1.37']);

  expect(run.exitCode).toBe(1);
});

test('it logs each call, oldest first', async () => {
  const ctx = await setupTest();

  const docker = createStubDockerBin(ctx.dir, {});

  Bun.spawnSync([join(docker.binDir, 'docker'), 'rm', '-f', 'one']);
  Bun.spawnSync([join(docker.binDir, 'docker'), 'rm', '-f', 'two']);

  expect(docker.readCalls()).toStrictEqual(['rm -f one', 'rm -f two']);
});
