import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGuestExec } from '../images/guest-exec';
import { PIN_INSPECT_FORMAT } from '../images/image-pin';
import { STUB_BUILDER_CONTAINER, buildStubImageBuilder } from './build-stub-image-builder';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'stub-image-builder-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it answers the pin inspect of any image on linux/amd64 with its registry digest', async () => {
  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });
  const exec = createGuestExec(builder.guest.open);

  const result = await exec(
    ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, 'busybox:1.37'],
    { signal: new AbortController().signal },
  );

  expect(JSON.parse(result.stdout)).toStrictEqual({
    Id: `sha256:${'c'.repeat(64)}`,
    RepoDigests: [`busybox@sha256:${'b'.repeat(64)}`],
    Os: 'linux',
    Architecture: 'amd64',
    Config: {},
  });
});

test('it reports the engine platform as the version format renders it', async () => {
  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });
  const exec = createGuestExec(builder.guest.open);

  const result = await exec(['docker', 'version', '--format', '{{json .Server.Os}}'], {
    signal: new AbortController().signal,
  });

  expect(result.stdout).toBe('"linux" "x86_64"\n');
});

test('it records the Dockerfile of each context a build gets on stdin', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });

  await writeFile(join(ctx.dir, 'Dockerfile'), 'FROM scratch\n');

  Bun.spawnSync(['tar', '-C', ctx.dir, '-cf', join(ctx.dir, 'context.tar'), 'Dockerfile']);

  const answered = await builder.builders.withBuilder(new AbortController().signal, (exec) =>
    exec(['docker', 'build', '-'], {
      signal: new AbortController().signal,
      stdinPath: join(ctx.dir, 'context.tar'),
    }),
  );

  expect(answered.exitCode).toBe(0);
  expect(builder.builtDockerfiles).toStrictEqual(['FROM scratch\n']);
});

test('it streams its export chunks for the container its create made', async () => {
  const builder = buildStubImageBuilder({
    exported: [new TextEncoder().encode('ab'), new TextEncoder().encode('cd')],
    repoDigest: 'sha256:1',
  });

  const exec = createGuestExec(builder.guest.open);

  const result = await exec(['docker', 'export', STUB_BUILDER_CONTAINER], {
    signal: new AbortController().signal,
  });

  expect(result.stdout).toBe('abcd');
});

test('it answers a pull as the test says', async () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: 'sha256:1',
    onPull: () => ({ code: 1, stderr: 'manifest unknown' }),
  });

  const exec = createGuestExec(builder.guest.open);

  const result = await exec(['docker', 'pull', '--quiet', 'x:1'], {
    signal: new AbortController().signal,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe('manifest unknown');
});

test('it fails a call it does not model and names it', async () => {
  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });
  const exec = createGuestExec(builder.guest.open);

  const result = await exec(['docker', 'run', 'x'], { signal: new AbortController().signal });

  expect(result.stderr).toBe('the stub builder has no run x');
});

test('it counts each builder booted and lets it go when its build fails', async () => {
  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });

  const building = builder.builders.withBuilder(new AbortController().signal, () => {
    throw new Error('failed');
  });

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(Error, 'failed');
  expect(builder.readBoots()).toBe(1);
  expect(builder.readLive()).toBe(0);
});

test('it keeps a builder live while its build runs', async () => {
  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });

  const live = await builder.builders.withBuilder(new AbortController().signal, () =>
    Promise.resolve(builder.readLive()),
  );

  expect(live).toBe(1);
  expect(builder.readLive()).toBe(0);
});

test('it answers the config inspect of the built tag with a JSON object', async () => {
  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });
  const exec = createGuestExec(builder.guest.open);

  const result = await exec(
    ['docker', 'image', 'inspect', '--format', '{{json .Config}}', 'imp-build:latest'],
    { signal: new AbortController().signal },
  );

  expect(JSON.parse(result.stdout)).toStrictEqual({ Cmd: ['/bin/sh'], Env: ['PATH=/bin'] });
});

test('it answers a create of the built tag with its container ID', async () => {
  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });
  const exec = createGuestExec(builder.guest.open);

  const result = await exec(['docker', 'create', 'imp-build:latest', '/bin/true'], {
    signal: new AbortController().signal,
  });

  expect(result.stdout).toBe(`${STUB_BUILDER_CONTAINER}\n`);
});

test('it answers the config inspect of the built tag with the config the test gives', async () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: 'sha256:1',
    config: '{"Cmd":["bash"]}\n',
  });

  const exec = createGuestExec(builder.guest.open);

  const result = await exec(
    ['docker', 'image', 'inspect', '--format', '{{json .Config}}', 'imp-build:latest'],
    { signal: new AbortController().signal },
  );

  expect(result.stdout).toBe('{"Cmd":["bash"]}\n');
});

test('it reports the architecture the test gives for a pulled image', async () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    architecture: 'aarch64',
  });

  const exec = createGuestExec(builder.guest.open);

  const result = await exec(
    ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, 'busybox:1.37'],
    { signal: new AbortController().signal },
  );

  expect(JSON.parse(result.stdout)).toMatchObject({ Os: 'linux', Architecture: 'aarch64' });
});

// each failure exits 1 with the stderr, as the docker CLI does for an
// engine error
test.each([
  ['pin', ['docker', 'image', 'inspect', '--format', PIN_INSPECT_FORMAT, 'busybox:1.37']],
  ['tag', ['docker', 'tag', 'busybox:1.37', 'imp-build:latest']],
  ['config', ['docker', 'image', 'inspect', '--format', '{{json .Config}}', 'imp-build:latest']],
  ['create', ['docker', 'create', 'imp-build:latest', '/bin/true']],
  ['export', ['docker', 'export', STUB_BUILDER_CONTAINER]],
] as const)('it fails the %s step with the stderr the test gives', async (step, argv) => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: 'sha256:1',
    failures: { [step]: 'no space left on device' },
  });

  const exec = createGuestExec(builder.guest.open);

  const result = await exec(argv, { signal: new AbortController().signal });

  expect(result).toStrictEqual({ exitCode: 1, stdout: '', stderr: 'no space left on device\n' });
});

test('it keeps a stalled export open until the exec is closed', async () => {
  const exported = Promise.withResolvers<void>();

  const builder = buildStubImageBuilder({
    exported: [new TextEncoder().encode('ab')],
    repoDigest: 'sha256:1',
    isExportStalled: true,
    onExport: () => {
      exported.resolve();

      return Promise.resolve();
    },
  });

  const controller = new AbortController();

  const exec = createGuestExec(builder.guest.open);

  const exporting = exec(['docker', 'export', STUB_BUILDER_CONTAINER], {
    signal: controller.signal,
  });

  await exported.promise;

  controller.abort();

  expect(exporting).rejects.toMatchObject({ name: 'AbortError' });
  expect(builder.guest.runs.at(-1)?.closed).toBeTrue();
});
