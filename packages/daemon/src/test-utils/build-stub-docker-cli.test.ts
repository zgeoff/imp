import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@imp/test-utils/wait-for';
import { PIN_INSPECT_FORMAT } from '../images/image-pin';
import { runCommand } from '../process/run-command';
import { buildStubDockerCli } from './build-stub-docker-cli';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'stub-docker-cli-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it prints the version platform as the format impd passes renders it', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({ dir: ctx.dir, version: { os: 'linux', arch: 'aarch64' } });

  const result = await runCommand(
    ['docker', 'version', '--format', '{{json .Server.Os}} {{json .Server.Arch}}'],
    { env: { PATH: docker.path } },
  );

  expect(result.stdout).toBe('"linux" "aarch64"\n');
});

test('it prints an inspect as a one-element JSON array without a format', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [{ refs: ['busybox:1.37'], inspects: [{ Id: 'sha256:1', Config: { Env: ['A=1'] } }] }],
  });

  const result = await runCommand(['docker', 'image', 'inspect', 'busybox:1.37'], {
    env: { PATH: docker.path },
  });

  expect(JSON.parse(result.stdout)).toStrictEqual([{ Id: 'sha256:1', Config: { Env: ['A=1'] } }]);
});

test('it renders the pin inspect format with the fields the CLI prints', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [
      { refs: ['busybox:1.37'], inspects: [{ Id: 'sha256:1', RepoDigests: ['busybox@sha256:2'] }] },
    ],
  });

  const result = await runCommand(
    ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, 'busybox:1.37'],
    { env: { PATH: docker.path } },
  );

  expect(JSON.parse(result.stdout)).toStrictEqual({
    Id: 'sha256:1',
    RepoDigests: ['busybox@sha256:2'],
    Os: 'linux',
    Architecture: 'amd64',
    Config: null,
  });
});

test('it prints the image ID for the Id format', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [{ refs: ['busybox:1.37'], inspects: [{ Id: 'sha256:1' }] }],
  });

  const result = await runCommand(
    ['docker', 'image', 'inspect', '--format', '{{.Id}}', 'busybox:1.37'],
    { env: { PATH: docker.path } },
  );

  expect(result.stdout).toBe('sha256:1\n');
});

test('it prints the config for the config format', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [{ refs: ['busybox:1.37'], inspects: [{ Id: 'sha256:1', Config: { Cmd: ['sh'] } }] }],
  });

  const result = await runCommand(
    ['docker', 'image', 'inspect', '--format', '{{json .Config}}', 'busybox:1.37'],
    { env: { PATH: docker.path } },
  );

  expect(JSON.parse(result.stdout)).toStrictEqual({ Cmd: ['sh'] });
});

test('it prints each inspect of a sequence in turn, then the last again', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [{ refs: ['moving:1'], inspects: [{ Id: 'sha256:1' }, { Id: 'sha256:2' }] }],
  });

  const ids = [];

  for (let call = 0; call < 3; call += 1) {
    const result = await runCommand(
      ['docker', 'image', 'inspect', '--format', '{{.Id}}', 'moving:1'],
      {
        env: { PATH: docker.path },
      },
    );

    ids.push(result.stdout.trim());
  }

  expect(ids).toStrictEqual(['sha256:1', 'sha256:2', 'sha256:2']);
});

test('it fails the inspect of an image that is not on the host yet', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [{ refs: ['busybox:1.37'], inspects: [{ Id: 'sha256:1' }], isOnHost: false }],
  });

  const result = await runCommand(['docker', 'image', 'inspect', 'busybox:1.37'], {
    env: { PATH: docker.path },
  });

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'Error: No such image: busybox:1.37\n',
  });
});

test('it lands an image on the host when its pull succeeds', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [{ refs: ['busybox:1.37'], inspects: [{ Id: 'sha256:1' }], isOnHost: false }],
  });

  await runCommand(['docker', 'pull', '--quiet', 'busybox:1.37'], { env: { PATH: docker.path } });

  const result = await runCommand(
    ['docker', 'image', 'inspect', '--format', '{{.Id}}', 'busybox:1.37'],
    { env: { PATH: docker.path } },
  );

  expect(result.stdout).toBe('sha256:1\n');
});

// docker pull --quiet prints the ref and exits 0; the image can still be
// gone by the next call, as when another client removes it
test('it reports a lost pull as done but leaves the image off the host', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [
      { refs: ['busybox:1.37'], inspects: [{ Id: 'sha256:1' }], isOnHost: false, pull: 'lost' },
    ],
  });

  const pulled = await runCommand(['docker', 'pull', '--quiet', 'busybox:1.37'], {
    env: { PATH: docker.path },
  });

  const inspected = await runCommand(
    ['docker', 'image', 'inspect', '--format', '{{.Id}}', 'busybox:1.37'],
    { env: { PATH: docker.path } },
  );

  expect(pulled).toStrictEqual({ exitCode: 0, stdout: 'busybox:1.37\n', stderr: '' });

  expect(inspected).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'Error: No such image: busybox:1.37\n',
  });
});

// `{{json .Server.Os}}` renders null when the CLI reaches no server
test('it prints the version line it was given as it is', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({ dir: ctx.dir, version: { stdout: 'null null' } });

  const result = await runCommand(
    ['docker', 'version', '--format', '{{json .Server.Os}} {{json .Server.Arch}}'],
    { env: { PATH: docker.path } },
  );

  expect(result).toStrictEqual({ exitCode: 0, stdout: 'null null\n', stderr: '' });
});

test('it fails a pull with the stderr it was given', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [
      {
        refs: ['mnt.test/x:1'],
        inspects: [{ Id: 'sha256:1' }],
        pull: { stderr: 'no such registry' },
      },
    ],
  });

  const result = await runCommand(['docker', 'pull', '--quiet', 'mnt.test/x:1'], {
    env: { PATH: docker.path },
  });

  expect(result).toStrictEqual({ exitCode: 1, stdout: '', stderr: 'no such registry\n' });
});

test('it holds a hanging pull until its kill', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({
    dir: ctx.dir,
    images: [{ refs: ['slow:1'], inspects: [{ Id: 'sha256:1' }], pull: 'hang' }],
  });

  const result = await runCommand(['docker', 'pull', '--quiet', 'slow:1'], {
    env: { PATH: docker.path },
    signal: AbortSignal.timeout(100),
  });

  expect(result.exitCode).toBe(143);
});

test('it ends a hanging pull once its directory is gone', async () => {
  const ctx = await setupTest();

  const dir = join(ctx.dir, 'stub');

  const docker = buildStubDockerCli({
    dir,
    images: [{ refs: ['slow:1'], inspects: [{ Id: 'sha256:1' }], pull: 'hang' }],
  });

  const pull = Bun.spawn([join(docker.bin, 'docker'), 'pull', '--quiet', 'slow:1'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });

  onTestFinished(() => {
    pull.kill();
  });

  await waitFor(() => {
    expect(docker.readCalls()).toStrictEqual(['pull --quiet slow:1']);
  });

  await rm(dir, { recursive: true, force: true });

  const code = await pull.exited;

  expect(code).toBe(1);
});

test('it prints the container ID a create makes', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({ dir: ctx.dir, create: { id: 'c'.repeat(64) } });

  const result = await runCommand(['docker', 'create', 'busybox', '/bin/true'], {
    env: { PATH: docker.path },
  });

  expect(result.stdout).toBe(`${'c'.repeat(64)}\n`);
});

test('it fails a create with the stderr it was given', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({ dir: ctx.dir, create: { stderr: 'no space left' } });

  const result = await runCommand(['docker', 'create', 'busybox', '/bin/true'], {
    env: { PATH: docker.path },
  });

  expect(result).toStrictEqual({ exitCode: 1, stdout: '', stderr: 'no space left\n' });
});

test('it prints the export tar it was given', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({ dir: ctx.dir, exportTar: new TextEncoder().encode('tar') });

  const result = await runCommand(['docker', 'export', 'c'.repeat(64)], {
    env: { PATH: docker.path },
  });

  expect(result.stdout).toBe('tar');
});

test('it fails a call it does not model and names it', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({ dir: ctx.dir });

  const result = await runCommand(['docker', 'run', 'busybox'], { env: { PATH: docker.path } });

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'stub docker: run busybox is not modelled\n',
  });
});

test('it logs each call argv in order', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({ dir: ctx.dir });

  await runCommand(['docker', 'rm', '-f', 'abc'], { env: { PATH: docker.path } });
  await runCommand(['docker', 'run', 'x'], { env: { PATH: docker.path } });

  expect(docker.readCalls()).toStrictEqual(['rm -f abc', 'run x']);
});

test('it logs no calls before the first', async () => {
  const ctx = await setupTest();

  const docker = buildStubDockerCli({ dir: ctx.dir });

  expect(docker.readCalls()).toStrictEqual([]);
});
