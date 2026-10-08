import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubDockerCli } from '../test-utils/build-stub-docker-cli';
import { readRefusalError, runDocker, runDockerChecked } from './run-docker';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'imp-run-docker-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('#readRefusalError reads the proxy refusal in the CLI output as the client BAD_REQUEST', () => {
  expect(
    readRefusalError(
      'docker pull',
      "Error response from daemon: imp-docker-proxy: registry localhost:5320 is the host's own\n",
    ),
  ).toMatchObject({
    code: 'BAD_REQUEST',
    message: "imp-docker-proxy: registry localhost:5320 is the host's own",
  });
});

test('#readRefusalError reads no refusal in output the proxy did not write', () => {
  expect(
    readRefusalError('docker pull', 'Error response from daemon: No such image: busybox:1\n'),
  ).toBeNull();
});

test('#runDocker answers a failed call with its exit code and output', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({ dir: ctx.dir });

  const result = await runDocker(['run', 'busybox'], { env: { PATH: docker.path } });

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'stub docker: run busybox is not modelled\n',
  });
});

test('#runDocker throws the proxy refusal of a call as the client BAD_REQUEST', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [
      {
        refs: ['localhost:5320/x:1'],
        inspects: [{ Id: 'sha256:1' }],
        pull: {
          stderr:
            "Error response from daemon: imp-docker-proxy: registry localhost:5320 is the host's own",
        },
      },
    ],
  });

  expect(
    runDocker(['pull', '--quiet', 'localhost:5320/x:1'], { env: { PATH: docker.path } }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: "imp-docker-proxy: registry localhost:5320 is the host's own",
  });
});

test('#runDockerChecked gives the output of a checked call that succeeds', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({ dir: ctx.dir, create: { id: 'c'.repeat(64) } });

  const stdout = await runDockerChecked(['create', 'busybox', '/bin/true'], {
    env: { PATH: docker.path },
  });

  expect(stdout).toBe(`${'c'.repeat(64)}\n`);
});

test('#runDockerChecked throws a checked call that exits non-zero with its argv and stderr', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({ dir: ctx.dir, create: { stderr: 'no space left' } });

  expect(
    runDockerChecked(['create', 'busybox', '/bin/true'], { env: { PATH: docker.path } }),
  ).rejects.toThrowWithMessage(Error, 'docker create busybox /bin/true exited 1: no space left');
});

test('#runDocker ends a call when its signal aborts', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [{ refs: ['slow:1'], inspects: [{ Id: 'sha256:1' }], pull: 'hang' }],
  });

  const controller = new AbortController();

  const pulling = runDocker(['pull', '--quiet', 'slow:1'], {
    env: { PATH: docker.path },
    signal: controller.signal,
  });

  controller.abort();

  const result = await pulling;

  // 128 + SIGTERM, which an aborted spawn sends
  expect(result.exitCode).toBe(143);
});
