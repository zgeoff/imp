import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCKERFILE_FRONTEND } from '../docker-proxy/dockerfile-frontend';
import { buildStubGuest } from '../test-utils/build-stub-guest';
import {
  STUB_BUILDER_CONTAINER,
  buildStubImageBuilder,
} from '../test-utils/build-stub-image-builder';
import { DockerBuildError } from './docker-build';
import { loadGuestImage, runGuestBuild, writeGuestTree } from './guest-build';
import { createGuestExec } from './guest-exec';
import { ImageLimitError } from './image-limit-error';
import { PIN_INSPECT_FORMAT } from './image-pin';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'imp-guest-build-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const root = join(dir, 'root');

  // where writeGuestTree unpacks the export
  mkdirSync(root);

  return { dir, root };
}

test('#writeGuestTree unpacks the builder export into the root', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dir, 'tree', 'etc'), { recursive: true });
  writeFileSync(join(ctx.dir, 'tree', 'etc', 'hello'), 'hi\n'.repeat(100_000));

  const builder = buildStubImageBuilder({
    exported: [Bun.spawnSync(['tar', '-C', join(ctx.dir, 'tree'), '-c', '.']).stdout],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  await writeGuestTree(
    createGuestExec(builder.guest.open),
    ctx.root,
    { maxBytes: 1024 ** 3, maxFiles: 100 },
    new AbortController().signal,
  );

  expect(readFileSync(join(ctx.root, 'etc', 'hello'), 'utf8')).toBe('hi\n'.repeat(100_000));
});

test('#writeGuestTree gives the image config the builder inspected', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dir, 'tree'));
  writeFileSync(join(ctx.dir, 'tree', 'hello'), 'hi\n');

  const builder = buildStubImageBuilder({
    exported: [Bun.spawnSync(['tar', '-C', join(ctx.dir, 'tree'), '-c', '.']).stdout],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    config: '{"Cmd":["sh"],"Env":["A=1"]}\n',
  });

  const image = await writeGuestTree(
    createGuestExec(builder.guest.open),
    ctx.root,
    { maxBytes: 1024 ** 3, maxFiles: 100 },
    new AbortController().signal,
  );

  expect(image.config).toStrictEqual({ Cmd: ['sh'], Env: ['A=1'] });
});

test('#writeGuestTree gives a build digest of 64 hex characters', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dir, 'tree'));
  writeFileSync(join(ctx.dir, 'tree', 'hello'), 'hi\n');

  const builder = buildStubImageBuilder({
    exported: [Bun.spawnSync(['tar', '-C', join(ctx.dir, 'tree'), '-c', '.']).stdout],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const image = await writeGuestTree(
    createGuestExec(builder.guest.open),
    ctx.root,
    { maxBytes: 1024 ** 3, maxFiles: 100 },
    new AbortController().signal,
  );

  expect(image.digest).toMatch(/^imp-build-[0-9a-f]{64}$/v);
});

test('#writeGuestTree gives the same digest for the same config and export', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dir, 'tree'));
  writeFileSync(join(ctx.dir, 'tree', 'hello'), 'hi\n');
  mkdirSync(join(ctx.dir, 'again'));

  const builder = buildStubImageBuilder({
    exported: [Bun.spawnSync(['tar', '-C', join(ctx.dir, 'tree'), '-c', '.']).stdout],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const limits = { maxBytes: 1024 ** 3, maxFiles: 100 };

  const signal = new AbortController().signal;

  const first = await writeGuestTree(createGuestExec(builder.guest.open), ctx.root, limits, signal);

  const second = await writeGuestTree(
    createGuestExec(builder.guest.open),
    join(ctx.dir, 'again'),
    limits,
    signal,
  );

  expect(second.digest).toBe(first.digest);
});

test('#writeGuestTree gives another digest for another config of the same export', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dir, 'tree'));
  writeFileSync(join(ctx.dir, 'tree', 'hello'), 'hi\n');
  mkdirSync(join(ctx.dir, 'again'));

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dir, 'tree'), '-c', '.']).stdout;

  const shell = buildStubImageBuilder({
    exported: [tar],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    config: '{"Cmd":["sh"]}\n',
  });

  const bash = buildStubImageBuilder({
    exported: [tar],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    config: '{"Cmd":["bash"]}\n',
  });

  const limits = { maxBytes: 1024 ** 3, maxFiles: 100 };

  const signal = new AbortController().signal;

  const first = await writeGuestTree(createGuestExec(shell.guest.open), ctx.root, limits, signal);

  const second = await writeGuestTree(
    createGuestExec(bash.guest.open),
    join(ctx.dir, 'again'),
    limits,
    signal,
  );

  expect(second.digest).not.toBe(first.digest);
});

test('#writeGuestTree gives another digest for another export of the same config', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dir, 'tree'));
  writeFileSync(join(ctx.dir, 'tree', 'hello'), 'hi\n');
  mkdirSync(join(ctx.dir, 'other'));
  writeFileSync(join(ctx.dir, 'other', 'hello'), 'bye\n');
  mkdirSync(join(ctx.dir, 'again'));

  const hello = buildStubImageBuilder({
    exported: [Bun.spawnSync(['tar', '-C', join(ctx.dir, 'tree'), '-c', '.']).stdout],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const bye = buildStubImageBuilder({
    exported: [Bun.spawnSync(['tar', '-C', join(ctx.dir, 'other'), '-c', '.']).stdout],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const limits = { maxBytes: 1024 ** 3, maxFiles: 100 };

  const signal = new AbortController().signal;

  const first = await writeGuestTree(createGuestExec(hello.guest.open), ctx.root, limits, signal);

  const second = await writeGuestTree(
    createGuestExec(bye.guest.open),
    join(ctx.dir, 'again'),
    limits,
    signal,
  );

  expect(second.digest).not.toBe(first.digest);
});

test('#writeGuestTree inspects, creates and exports the built image in the builder', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dir, 'tree'));

  const builder = buildStubImageBuilder({
    exported: [Bun.spawnSync(['tar', '-C', join(ctx.dir, 'tree'), '-c', '.']).stdout],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  await writeGuestTree(
    createGuestExec(builder.guest.open),
    ctx.root,
    { maxBytes: 1024 ** 3, maxFiles: 100 },
    new AbortController().signal,
  );

  expect(builder.guest.runs.map((run) => run.argv.join(' '))).toStrictEqual([
    'docker image inspect --format {{json .Config}} imp-build:latest',
    'docker create imp-build:latest /bin/true',
    `docker export ${STUB_BUILDER_CONTAINER}`,
  ]);
});

test('#writeGuestTree holds disk ahead of the export in 256 MiB steps', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dir, 'tree'));
  writeFileSync(join(ctx.dir, 'tree', 'hello'), 'hi\n');

  const holds: number[] = [];

  const builder = buildStubImageBuilder({
    exported: [Bun.spawnSync(['tar', '-C', join(ctx.dir, 'tree'), '-c', '.']).stdout],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  await writeGuestTree(
    createGuestExec(builder.guest.open),
    ctx.root,
    { maxBytes: 1024 ** 3, maxFiles: 100 },
    new AbortController().signal,
    (totalBytes) => {
      holds.push(totalBytes);

      return Promise.resolve();
    },
  );

  expect(holds).toStrictEqual([256 * 1024 ** 2]);
});

test('#writeGuestTree refuses an export past the byte cap', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dir, 'tree'));
  writeFileSync(join(ctx.dir, 'tree', 'big'), 'x'.repeat(4 * 64 * 1024));

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dir, 'tree'), '-c', '.']).stdout;

  const builder = buildStubImageBuilder({
    exported: Array.from({ length: Math.ceil(tar.byteLength / 65_536) }, (_, index) =>
      tar.subarray(index * 65_536, (index + 1) * 65_536),
    ),
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  expect(
    writeGuestTree(
      createGuestExec(builder.guest.open),
      ctx.root,
      { maxBytes: 2 * 65_536, maxFiles: 100 },
      new AbortController().signal,
    ),
  ).rejects.toThrowWithMessage(
    ImageLimitError,
    "the built image's filesystem is over 0 MiB (IMP_BUILD_IMAGE_MAX_MIB)",
  );
});

test('#writeGuestTree ends the export exec at the byte cap', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dir, 'tree'));
  writeFileSync(join(ctx.dir, 'tree', 'big'), 'x'.repeat(4 * 64 * 1024));

  const tar = Bun.spawnSync(['tar', '-C', join(ctx.dir, 'tree'), '-c', '.']).stdout;

  const builder = buildStubImageBuilder({
    exported: Array.from({ length: Math.ceil(tar.byteLength / 65_536) }, (_, index) =>
      tar.subarray(index * 65_536, (index + 1) * 65_536),
    ),
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const writing = writeGuestTree(
    createGuestExec(builder.guest.open),
    ctx.root,
    { maxBytes: 2 * 65_536, maxFiles: 100 },
    new AbortController().signal,
  );

  expect(writing).rejects.toBeInstanceOf(ImageLimitError);
  expect(builder.guest.runs.at(-1)?.closed).toBeTrue();
});

test('#writeGuestTree refuses an export of more entries than the file cap', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dir, 'tree'));

  await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      Bun.write(join(ctx.dir, 'tree', `f${String(index)}`), ''),
    ),
  );

  const builder = buildStubImageBuilder({
    exported: [Bun.spawnSync(['tar', '-C', join(ctx.dir, 'tree'), '-c', '.']).stdout],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  expect(
    writeGuestTree(
      createGuestExec(builder.guest.open),
      ctx.root,
      { maxBytes: 1024 ** 3, maxFiles: 10 },
      new AbortController().signal,
    ),
  ).rejects.toThrowWithMessage(
    ImageLimitError,
    "the built image's filesystem is over 10 files (IMP_BUILD_IMAGE_MAX_FILES)",
  );
});

test('#writeGuestTree counts a sparse file at its full size against the cap', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dir, 'tree'));

  Bun.spawnSync(['truncate', '-s', '16M', join(ctx.dir, 'tree', 'holes')]);

  // an archive well inside the cap, of a file that is not
  const builder = buildStubImageBuilder({
    exported: [Bun.spawnSync(['tar', '-S', '-C', join(ctx.dir, 'tree'), '-c', '.']).stdout],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  expect(
    writeGuestTree(
      createGuestExec(builder.guest.open),
      ctx.root,
      { maxBytes: 1024 ** 2, maxFiles: 1000 },
      new AbortController().signal,
    ),
  ).rejects.toThrowWithMessage(
    ImageLimitError,
    "the built image's filesystem is over 1 MiB (IMP_BUILD_IMAGE_MAX_MIB)",
  );
});

test('#writeGuestTree counts a block for each small file against the cap', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dir, 'tree'));

  await Promise.all(
    Array.from({ length: 300 }, (_, index) =>
      Bun.write(join(ctx.dir, 'tree', `f${String(index)}`), 'x'),
    ),
  );

  // an archive well inside the cap, of files whose blocks are not
  const builder = buildStubImageBuilder({
    exported: [Bun.spawnSync(['tar', '-C', join(ctx.dir, 'tree'), '-c', '.']).stdout],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  expect(
    writeGuestTree(
      createGuestExec(builder.guest.open),
      ctx.root,
      { maxBytes: 1024 ** 2, maxFiles: 1000 },
      new AbortController().signal,
    ),
  ).rejects.toThrowWithMessage(
    ImageLimitError,
    "the built image's filesystem is over 1 MiB (IMP_BUILD_IMAGE_MAX_MIB)",
  );
});

// one file under 80 directories the archive does not hold, which tar makes
test('#writeGuestTree counts the directories tar makes for a member as entries', async () => {
  const ctx = await setupTest();

  const parents = Array.from({ length: 80 }, (_, index) => `d${String(index)}`).join('/');

  mkdirSync(join(ctx.dir, 'deep', parents), { recursive: true });
  writeFileSync(join(ctx.dir, 'deep', parents, 'f'), 'x');

  const builder = buildStubImageBuilder({
    exported: [
      Bun.spawnSync(['tar', '-C', join(ctx.dir, 'deep'), '--no-recursion', '-c', `${parents}/f`])
        .stdout,
    ],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  expect(
    writeGuestTree(
      createGuestExec(builder.guest.open),
      ctx.root,
      { maxBytes: 1024 ** 3, maxFiles: 1 },
      new AbortController().signal,
    ),
  ).rejects.toThrowWithMessage(
    ImageLimitError,
    "the built image's filesystem is over 1 files (IMP_BUILD_IMAGE_MAX_FILES)",
  );
});

test('#writeGuestTree counts the directories tar makes for a member as blocks', async () => {
  const ctx = await setupTest();

  const parents = Array.from({ length: 80 }, (_, index) => `d${String(index)}`).join('/');

  mkdirSync(join(ctx.dir, 'deep', parents), { recursive: true });
  writeFileSync(join(ctx.dir, 'deep', parents, 'f'), 'x');

  const builder = buildStubImageBuilder({
    exported: [
      Bun.spawnSync(['tar', '-C', join(ctx.dir, 'deep'), '--no-recursion', '-c', `${parents}/f`])
        .stdout,
    ],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  expect(
    writeGuestTree(
      createGuestExec(builder.guest.open),
      ctx.root,
      { maxBytes: 64 * 1024, maxFiles: 1000 },
      new AbortController().signal,
    ),
  ).rejects.toThrowWithMessage(
    ImageLimitError,
    "the built image's filesystem is over 0 MiB (IMP_BUILD_IMAGE_MAX_MIB)",
  );
});

test('#writeGuestTree ends an export that stalls past a limit', async () => {
  const ctx = await setupTest();

  const parents = Array.from({ length: 80 }, (_, index) => `d${String(index)}`).join('/');

  mkdirSync(join(ctx.dir, 'deep', parents), { recursive: true });
  writeFileSync(join(ctx.dir, 'deep', parents, 'f'), 'x');

  const builder = buildStubImageBuilder({
    exported: [
      Bun.spawnSync(['tar', '-C', join(ctx.dir, 'deep'), '--no-recursion', '-c', `${parents}/f`])
        .stdout,
    ],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    isExportStalled: true,
  });

  const writing = writeGuestTree(
    createGuestExec(builder.guest.open),
    ctx.root,
    { maxBytes: 1024 ** 3, maxFiles: 1 },
    new AbortController().signal,
  );

  expect(writing).rejects.toThrowWithMessage(
    ImageLimitError,
    "the built image's filesystem is over 1 files (IMP_BUILD_IMAGE_MAX_FILES)",
  );

  expect(builder.guest.runs.at(-1)?.closed).toBeTrue();
});

test('#writeGuestTree ends an export that sends nothing for its idle limit', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    isExportStalled: true,
  });

  const writing = writeGuestTree(
    createGuestExec(builder.guest.open),
    ctx.root,
    { maxBytes: 1024 ** 3, maxFiles: 1000, idleMs: 50 },
    new AbortController().signal,
  );

  expect(writing).rejects.toThrowWithMessage(
    Error,
    'docker export in the builder sent nothing in 0.05 s',
  );

  expect(builder.guest.runs.at(-1)?.closed).toBeTrue();
});

test("#writeGuestTree refuses a builder's config that is not one JSON object", async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    config: '["not", "a", "config"]\n',
  });

  const writing = writeGuestTree(
    createGuestExec(builder.guest.open),
    ctx.root,
    { maxBytes: 1024, maxFiles: 100 },
    new AbortController().signal,
  );

  expect(writing).rejects.toThrowWithMessage(Error, /expected record/v);
  expect(builder.guest.runs).toHaveLength(1);
});

test('#writeGuestTree fails when the inspect in the builder exits non-zero', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    failures: { config: 'No such image: imp-build:latest' },
  });

  expect(
    writeGuestTree(
      createGuestExec(builder.guest.open),
      ctx.root,
      { maxBytes: 1024, maxFiles: 100 },
      new AbortController().signal,
    ),
  ).rejects.toThrowWithMessage(
    Error,
    'docker image inspect in the builder: No such image: imp-build:latest',
  );
});

test('#writeGuestTree fails when the create in the builder exits non-zero', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    failures: { create: 'no space left on device' },
  });

  expect(
    writeGuestTree(
      createGuestExec(builder.guest.open),
      ctx.root,
      { maxBytes: 1024, maxFiles: 100 },
      new AbortController().signal,
    ),
  ).rejects.toThrowWithMessage(Error, 'docker create in the builder: no space left on device');
});

test('#writeGuestTree fails when the export in the builder exits non-zero', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    failures: { export: 'container gone' },
  });

  expect(
    writeGuestTree(
      createGuestExec(builder.guest.open),
      ctx.root,
      { maxBytes: 1024 ** 3, maxFiles: 100 },
      new AbortController().signal,
    ),
  ).rejects.toThrowWithMessage(Error, 'docker export in the builder: container gone');
});

test('#runGuestBuild sends the context to the build as its stdin', async () => {
  const ctx = await setupTest();

  const stdin = Promise.withResolvers<string>();

  const guest = buildStubGuest(async (run) => {
    const bytes = await run.readStdin();

    stdin.resolve(new TextDecoder().decode(bytes));

    return {};
  });

  writeFileSync(join(ctx.dir, 'context.tar'), 'the context');

  await runGuestBuild(createGuestExec(guest.open), {
    tarPath: join(ctx.dir, 'context.tar'),
    dockerfile: 'sub/Dockerfile',
    signal: new AbortController().signal,
  });

  expect(stdin.promise).resolves.toBe('the context');
});

test('#runGuestBuild builds with the pinned frontend, the builder tag and the Dockerfile', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({}));

  writeFileSync(join(ctx.dir, 'context.tar'), 'the context');

  await runGuestBuild(createGuestExec(guest.open), {
    tarPath: join(ctx.dir, 'context.tar'),
    dockerfile: 'sub/Dockerfile',
    signal: new AbortController().signal,
  });

  expect(guest.runs.map((run) => run.argv)).toStrictEqual([
    [
      'docker',
      'build',
      '--progress=plain',
      '--build-arg',
      `BUILDKIT_SYNTAX=${DOCKERFILE_FRONTEND}`,
      '--tag',
      'imp-build:latest',
      '--file',
      'sub/Dockerfile',
      '-',
    ],
  ]);
});

test('#runGuestBuild fails a build with the last 8000 characters of its log', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({
    code: 1,
    stderr: `${'early '.repeat(2000)}\n#5 ERROR: process "/bin/sh -c false"`,
  }));

  writeFileSync(join(ctx.dir, 'context.tar'), 'the context');

  expect(
    runGuestBuild(createGuestExec(guest.open), {
      tarPath: join(ctx.dir, 'context.tar'),
      dockerfile: 'Dockerfile',
      signal: new AbortController().signal,
    }),
  ).rejects.toThrowWithMessage(
    DockerBuildError,
    /^docker build failed:\n[a-z ]{7963}\n#5 ERROR: process "\/bin\/sh -c false"$/v,
  );
});

test('#loadGuestImage pulls the ref for the platform, tags it and gives its registry digest', async () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const digest = await loadGuestImage(createGuestExec(builder.guest.open), {
    ref: 'busybox:1.37',
    platform: 'linux/amd64',
    signal: new AbortController().signal,
  });

  expect(digest).toBe(`busybox@sha256:${'b'.repeat(64)}`);

  expect(builder.guest.runs.map((run) => run.argv.join(' '))).toStrictEqual([
    'docker pull --quiet --platform linux/amd64 busybox:1.37',
    `docker image inspect --format ${PIN_INSPECT_FORMAT} busybox:1.37`,
    'docker tag busybox:1.37 imp-build:latest',
  ]);
});

test('#loadGuestImage refuses a ref whose pull in the builder fails as BAD_REQUEST', () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onPull: () => ({ code: 1, stderr: 'manifest unknown\n' }),
  });

  expect(
    loadGuestImage(createGuestExec(builder.guest.open), {
      ref: 'busybox:9',
      platform: 'linux/amd64',
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'the pull of busybox:9 in the builder failed: manifest unknown',
  });
});

test("#loadGuestImage refuses a ref the registry denies to the builder's engine", () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onPull: () => ({
      code: 1,
      stderr:
        'Error response from daemon: pull access denied for private/x, repository does not exist or may require docker login\n',
    }),
  });

  expect(
    loadGuestImage(createGuestExec(builder.guest.open), {
      ref: 'private/x:1',
      platform: 'linux/amd64',
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message:
      'the pull of private/x:1 in the builder failed: Error response from daemon: pull access denied for private/x, repository does not exist or may require docker login',
  });
});

// imp-docker-proxy's 403, as the docker CLI prints an engine refusal
test('#loadGuestImage refuses a ref whose pull imp-docker-proxy refuses in the builder', () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onPull: () => ({
      code: 1,
      stderr:
        "Error response from daemon: imp-docker-proxy: registry localhost:5320 is the host's own\n",
    }),
  });

  expect(
    loadGuestImage(createGuestExec(builder.guest.open), {
      ref: 'localhost:5320/x:1',
      platform: 'linux/amd64',
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message:
      "the pull of localhost:5320/x:1 in the builder failed: Error response from daemon: imp-docker-proxy: registry localhost:5320 is the host's own",
  });
});

test('#loadGuestImage fails when the inspect after the pull exits non-zero', () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    failures: { pin: 'No such image: busybox:1.37' },
  });

  expect(
    loadGuestImage(createGuestExec(builder.guest.open), {
      ref: 'busybox:1.37',
      platform: 'linux/amd64',
      signal: new AbortController().signal,
    }),
  ).rejects.toThrowWithMessage(
    Error,
    'docker image inspect busybox:1.37 in the builder: No such image: busybox:1.37',
  );
});

test('#loadGuestImage refuses an image the builder pulled for another platform', () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    architecture: 'aarch64',
  });

  expect(
    loadGuestImage(createGuestExec(builder.guest.open), {
      ref: 'busybox:1.37',
      platform: 'linux/amd64',
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'busybox:1.37 pulled for linux/arm64, not linux/amd64',
  });
});

test('#loadGuestImage fails when the tag in the builder exits non-zero', () => {
  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    failures: { tag: 'no space left on device' },
  });

  expect(
    loadGuestImage(createGuestExec(builder.guest.open), {
      ref: 'busybox:1.37',
      platform: 'linux/amd64',
      signal: new AbortController().signal,
    }),
  ).rejects.toThrowWithMessage(Error, 'docker tag in the builder: no space left on device');
});
