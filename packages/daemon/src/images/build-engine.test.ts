import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCKERFILE_FRONTEND } from '../docker-proxy/dockerfile-frontend';
import { runCommand } from '../process/run-command';
import { buildStubDockerCli } from '../test-utils/build-stub-docker-cli';
import { createBuildEngine } from './build-engine';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'imp-build-engine-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('#readPlatform reads the engine platform as containerd names it', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({ dir: ctx.dir, version: { os: 'linux', arch: 'aarch64' } });

  const engine = createBuildEngine((argv, signal) =>
    runCommand(argv, { env: { PATH: docker.path }, signal }),
  );

  const platform = await engine.readPlatform(new AbortController().signal);

  expect(platform).toBe('linux/arm64');
});

test('#readPlatform fails to read the platform of an engine that does not answer', () => {
  const engine = createBuildEngine(() =>
    Promise.resolve({ exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon\n' }),
  );

  expect(engine.readPlatform(new AbortController().signal)).rejects.toThrowWithMessage(
    Error,
    'docker version: Cannot connect to the Docker daemon',
  );
});

test('#readPlatform fails to read a version answer that names no platform', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({ dir: ctx.dir, version: { stdout: 'null null' } });

  const engine = createBuildEngine((argv, signal) =>
    runCommand(argv, { env: { PATH: docker.path }, signal }),
  );

  expect(engine.readPlatform(new AbortController().signal)).rejects.toThrowWithMessage(
    Error,
    /expected string, received null/v,
  );
});

test('#readPlatform refuses to read the platform once its signal aborted', () => {
  const engine = createBuildEngine(() =>
    Promise.resolve({ exitCode: 0, stdout: '"linux" "amd64"\n', stderr: '' }),
  );

  expect(engine.readPlatform(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
});

test('#loadImage reads an image the engine has without a pull', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [
      {
        refs: ['busybox:1.37'],
        inspects: [{ Id: 'sha256:1', RepoDigests: ['busybox@sha256:2'], Config: {} }],
      },
    ],
  });

  const engine = createBuildEngine((argv, signal) =>
    runCommand(argv, { env: { PATH: docker.path }, signal }),
  );

  const inspect = await engine.loadImage(
    { ref: 'busybox:1.37', use: 'FROM' },
    new AbortController().signal,
  );

  expect(inspect).toStrictEqual({
    Id: 'sha256:1',
    RepoDigests: ['busybox@sha256:2'],
    Os: 'linux',
    Architecture: 'amd64',
    OnBuild: null,
  });

  expect(docker.readCalls().filter((call) => call.startsWith('pull'))).toStrictEqual([]);
});

test('#loadImage pulls an image the engine lacks, then reads it', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [
      {
        refs: ['busybox:1.37'],
        inspects: [{ Id: 'sha256:1', RepoDigests: ['busybox@sha256:2'], Config: {} }],
        isOnHost: false,
      },
    ],
  });

  const engine = createBuildEngine((argv, signal) =>
    runCommand(argv, { env: { PATH: docker.path }, signal }),
  );

  await engine.loadImage({ ref: 'busybox:1.37', use: 'FROM' }, new AbortController().signal);

  expect(docker.readCalls().map((call) => call.split(' ').slice(0, 2).join(' '))).toStrictEqual([
    'image inspect',
    'pull --quiet',
    'image inspect',
  ]);
});

test('#loadImage refuses an image whose pull fails as the client BAD_REQUEST', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [
      {
        refs: ['mnt.test/x:1'],
        inspects: [{ Id: 'sha256:1' }],
        isOnHost: false,
        pull: { stderr: 'no such registry' },
      },
    ],
  });

  const engine = createBuildEngine((argv, signal) =>
    runCommand(argv, { env: { PATH: docker.path }, signal }),
  );

  expect(
    engine.loadImage({ ref: 'mnt.test/x:1', use: 'COPY --from' }, new AbortController().signal),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'COPY --from mnt.test/x:1: the pull failed: no such registry',
  });
});

test('#loadImage keeps the last 4000 characters of a failed pull', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [
      {
        refs: ['a:1'],
        inspects: [{ Id: 'sha256:1' }],
        isOnHost: false,
        pull: { stderr: `${'x'.repeat(5000)}denied` },
      },
    ],
  });

  const engine = createBuildEngine((argv, signal) =>
    runCommand(argv, { env: { PATH: docker.path }, signal }),
  );

  expect(
    engine.loadImage({ ref: 'a:1', use: 'FROM' }, new AbortController().signal),
  ).rejects.toMatchObject({
    message: `FROM a:1: the pull failed: ${'x'.repeat(3994)}denied`,
  });
});

test('#loadImage fails an image the engine still lacks after its pull', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [{ refs: ['a:1'], inspects: [{ Id: 'sha256:1' }], isOnHost: false, pull: 'lost' }],
  });

  const engine = createBuildEngine((argv, signal) =>
    runCommand(argv, { env: { PATH: docker.path }, signal }),
  );

  expect(
    engine.loadImage({ ref: 'a:1', use: 'FROM' }, new AbortController().signal),
  ).rejects.toThrowWithMessage(Error, 'docker image inspect a:1 failed after its pull');
});

test('#loadFrontend pulls no frontend the engine has', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [{ refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: 'sha256:f' }] }],
  });

  const engine = createBuildEngine((argv, signal) =>
    runCommand(argv, { env: { PATH: docker.path }, signal }),
  );

  await engine.loadFrontend(new AbortController().signal);

  expect(docker.readCalls()).toStrictEqual([
    `image inspect --format {{.Id}} ${DOCKERFILE_FRONTEND}`,
  ]);
});

test('#loadFrontend pulls the frontend the engine lacks', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [{ refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: 'sha256:f' }], isOnHost: false }],
  });

  const engine = createBuildEngine((argv, signal) =>
    runCommand(argv, { env: { PATH: docker.path }, signal }),
  );

  await engine.loadFrontend(new AbortController().signal);

  expect(docker.readCalls()).toStrictEqual([
    `image inspect --format {{.Id}} ${DOCKERFILE_FRONTEND}`,
    `pull --quiet ${DOCKERFILE_FRONTEND}`,
  ]);
});

test('#loadFrontend fails a frontend whose pull fails as BAD_GATEWAY', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [
      {
        refs: [DOCKERFILE_FRONTEND],
        inspects: [{ Id: 'sha256:f' }],
        isOnHost: false,
        pull: { stderr: 'no route to host' },
      },
    ],
  });

  const engine = createBuildEngine((argv, signal) =>
    runCommand(argv, { env: { PATH: docker.path }, signal }),
  );

  expect(engine.loadFrontend(new AbortController().signal)).rejects.toMatchObject({
    code: 'BAD_GATEWAY',
    message: `the Dockerfile frontend ${DOCKERFILE_FRONTEND}: the pull failed: no route to host`,
  });
});
