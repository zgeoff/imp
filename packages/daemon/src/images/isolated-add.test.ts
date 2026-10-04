import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createImage, findImageByName, listImages } from '../db/images';
import { listImps } from '../db/imps';
import { setupImpTest } from '../imps/test-imps';
import { buildImagePaths } from '../storage/data-layout';
import type { StorageBackend } from '../storage/storage-backend';
import { BUILDER_IMAGE, createBuilders } from './builder-imps';
import { createFakeGuest } from './fake-guest';
import type { FakeAnswer, FakeRun } from './fake-guest';
import { PIN_INSPECT_FORMAT } from './image-pin';
import { HOST_ADD_WARNING, createImageService } from './image-service';
import { createQueryGate } from './query-gate';

const CONTAINER_ID = 'e'.repeat(64);
const CONFIG = '{"Cmd":["/bin/sh"],"Env":["PATH=/bin"]}';
const REPO_DIGEST = `sha256:${'b'.repeat(64)}`;

interface AddTestOptions {
  readonly env?: Readonly<Record<string, string>>;

  // what the builder answers a pull, by default an image for linux/amd64
  readonly onPull?: (run: FakeRun) => Promise<FakeAnswer> | FakeAnswer;

  // what the builder exports, from a scratch directory; by default a small tree
  readonly buildExport?: (dir: string) => readonly Uint8Array[];

  // the builders get impd's own add of their image, not a test image
  readonly isRealBuilderImage?: boolean;

  // sh lines the host docker runs after it logs its call; by default none,
  // so every call fails
  readonly hostDocker?: (dataDir: string) => string;

  // how long the builder image's pull may take
  readonly builderImagePullMs?: number;

  // runs as an export starts; mkfs.ext4 waits for startMkfs
  readonly onExport?: () => Promise<void>;
  readonly pauseMkfs?: boolean;

  // a select of this name the gate can hold; a storage whose removals fail
  readonly gatedName?: string;
  readonly isRemoveFailing?: boolean;
}

// the error `adding` rejects with, or null
async function readFailure(adding: Promise<unknown>): Promise<unknown> {
  try {
    await adding;
  } catch (error) {
    return error;
  }

  return null;
}

// a tar of a directory holding these files
function buildTar(dir: string, files: Readonly<Record<string, string>>): Uint8Array {
  const tree = join(dir, `tree-${Bun.randomUUIDv7()}`);

  mkdirSync(tree, { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(tree, name), content);
  }

  return Bun.spawnSync(['tar', '-C', tree, '-c', ...Object.keys(files)]).stdout;
}

// A builder's engine on amd64, through the real builder lifecycle, and a
// host docker that logs every call and fails: an isolated add makes none
async function setupAdd(options: Readonly<AddTestOptions> = {}) {
  const ctx = await setupImpTest({
    env: { IMP_BUILD_MEMORY_MIB: '512', IMP_BUILD_DISK_GIB: '4', ...options.env },
  });

  await ctx.createTestImage('base');

  const exported = options.buildExport?.(ctx.dataDir) ?? [
    buildTar(ctx.dataDir, { hello: 'pulled\n' }),
  ];

  const runFakeStep = async (run: FakeRun): Promise<FakeAnswer> => {
    const argv = run.argv.slice(1).join(' ');

    if (argv.startsWith('info ')) {
      return {};
    }

    if (argv.startsWith('version ')) {
      return { stdout: '"linux" "x86_64"\n' };
    }

    if (argv.startsWith('pull ')) {
      const pulled = await options.onPull?.(run);

      return pulled ?? {};
    }

    if (argv.startsWith(`image inspect --format ${PIN_INSPECT_FORMAT} `)) {
      const ref = run.argv.at(-1) ?? '';
      const repository = ref.split(':')[0] ?? '';

      const inspect = {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`${repository}@${REPO_DIGEST}`],
        Os: 'linux',
        Architecture: 'amd64',
        Config: {},
      };

      return { stdout: JSON.stringify(inspect) };
    }

    if (argv.startsWith('tag ')) {
      return {};
    }

    if (argv === 'image inspect --format {{json .Config}} imp-build:latest') {
      return { stdout: CONFIG };
    }

    if (argv === 'create imp-build:latest /bin/true') {
      return { stdout: `${CONTAINER_ID}\n` };
    }

    if (argv === `export ${CONTAINER_ID}`) {
      await options.onExport?.();

      return { stdout: exported };
    }

    // a build, for an add and a build of one digest
    if (argv.startsWith('image inspect --format {{.Id}} docker/dockerfile')) {
      return { stdout: `sha256:${'f'.repeat(64)}\n` };
    }

    if (argv.startsWith('build ')) {
      await run.readStdin();

      return {};
    }

    return { code: 1, stderr: `the fake builder has no ${argv}` };
  };

  const guest = createFakeGuest(runFakeStep);
  const logs: string[] = [];
  const bin = join(ctx.dataDir, 'fake-bin');
  const hostLog = join(ctx.dataDir, 'host-docker.log');

  mkdirSync(bin);

  const hostLines = options.hostDocker?.(ctx.dataDir) ?? '';

  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh\necho "$*" >>'${hostLog}'\n${hostLines}\nexit 1\n`,
    {
      mode: 0o755,
    },
  );

  const mkfsStarted = join(ctx.dataDir, 'mkfs-started');
  const mkfsReleased = join(ctx.dataDir, 'mkfs-released');

  if (options.pauseMkfs === true) {
    const mkfs = Bun.which('mkfs.ext4', { PATH: `${process.env['PATH'] ?? ''}:/usr/sbin:/sbin` });

    writeFileSync(
      join(bin, 'mkfs.ext4'),
      `#!/bin/sh\ntouch '${mkfsStarted}'\nwhile [ ! -e '${mkfsReleased}' ]; do sleep 0.05; done\nexec '${mkfs ?? 'mkfs.ext4'}' "$@"\n`,
      { mode: 0o755 },
    );
  }

  const waitForMkfs = async () => {
    while (!existsSync(mkfsStarted)) {
      await Bun.sleep(20);
    }
  };

  const startMkfs = () => {
    writeFileSync(mkfsReleased, '');
  };

  const gate = createQueryGate(options.gatedName ?? '');

  const storage: StorageBackend =
    options.isRemoveFailing === true
      ? { ...ctx.storage, removeImage: () => Promise.reject(new Error('the disk is read-only')) }
      : ctx.storage;

  const holder: { images: ReturnType<typeof createImageService> | null } = { images: null };

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: { ...ctx.imps, openBuilderExec: (_name, request) => guest.open(request) },
    ensureImage: async () => {
      if (options.isRealBuilderImage === true) {
        await holder.images?.ensureBuilderImage();

        return;
      }

      const image = await findImageByName(ctx.db, BUILDER_IMAGE);

      if (image === undefined) {
        await ctx.createTestImage(BUILDER_IMAGE);
      }
    },
    log: (message) => {
      logs.push(message);
    },
  });

  const images = createImageService({
    config: ctx.config,
    db: ctx.db.withPlugin(gate.plugin),
    storage,
    storageGate: ctx.storageGate,
    diskBudget: ctx.diskBudget,
    readBuilders: () => builders,
    log: (message) => {
      logs.push(message);
    },
    ...(options.builderImagePullMs !== undefined && {
      builderImagePullMs: options.builderImagePullMs,
    }),
  });

  holder.images = images;

  // each call with the fake host docker first on PATH
  const withHostDocker = async <T>(run: () => Promise<T>): Promise<T> => {
    const savedPath = process.env['PATH'];

    process.env['PATH'] = `${bin}:${savedPath ?? ''}`;

    try {
      return await run();
    } finally {
      process.env['PATH'] = savedPath;
    }
  };

  const readHostCalls = () => (existsSync(hostLog) ? readFileSync(hostLog, 'utf8') : '');

  // the work directories an add leaves under images/, which none should
  const listWorkDirs = () =>
    readdirSync(join(ctx.dataDir, 'images')).filter((entry) => entry.startsWith('.build-'));

  // the rootfs directories of builder images under images/
  const listBuiltRootfs = () =>
    readdirSync(join(ctx.dataDir, 'images')).filter((entry) => entry.startsWith('imp-build-'));

  // a build of a context that makes the add's own export, so its digest
  const runBuild = (name: string, signal = new AbortController().signal) => {
    const tarPath = join(ctx.dataDir, `context-${Bun.randomUUIDv7()}.tar`);

    writeFileSync(tarPath, buildTar(ctx.dataDir, { Dockerfile: 'FROM busybox:1.37\nRUN true\n' }));

    return images.buildImageFromContext(tarPath, name, undefined, signal);
  };

  return Object.assign(ctx, {
    guest,
    logs,
    addImages: images,
    withHostDocker,
    readHostCalls,
    listWorkDirs,
    listBuiltRootfs,
    runBuild,
    waitForMkfs,
    startMkfs,
    gate,
  });
}

test('an add pulls and exports in a builder for one platform, and the host engine sees none of it', async () => {
  await using ctx = await setupAdd();

  const resolved: string[] = [];

  const image = await ctx.withHostDocker(() =>
    ctx.addImages.addImage('busybox', 'box', {
      onResolved: (reference) => {
        resolved.push(reference);
      },
    }),
  );

  // the reference the pull resolved, for the audit row
  expect(resolved).toEqual([`busybox@${REPO_DIGEST}`]);

  // keyed as a build is, by impd's own hash of what the builder sent
  expect(image).toMatchObject({ name: 'box', ref: 'busybox' });
  expect(image.digest).toMatch(/^imp-build-[a-f0-9]{64}$/v);
  expect(existsSync(buildImagePaths(ctx.dataDir, image.digest).rootfs)).toBe(true);
  expect(ctx.readHostCalls()).toBe('');
  expect(ctx.listWorkDirs()).toEqual([]);

  // the tag written out, the platform named, and the builder gone
  const commands = ctx.guest.runs.map((run) => run.argv.slice(1).join(' '));

  expect(commands).toContain('pull --quiet --platform linux/amd64 busybox:latest');
  expect(commands).toContain('tag busybox:latest imp-build:latest');

  const left = await listImps(ctx.db);

  expect(left).toEqual([]);

  expect(ctx.logs.join('\n')).toContain(
    `impd: image add box: busybox:latest for linux/amd64 (busybox@${REPO_DIGEST}), digest ${image.digest}`,
  );
});

test('a failed pull returns its error, and leaves no builder, rootfs or work directory', async () => {
  await using ctx = await setupAdd({
    onPull: () => ({ code: 1, stderr: 'Error response from daemon: manifest unknown' }),
  });

  const failure = await readFailure(
    ctx.withHostDocker(() => ctx.addImages.addImage('busybox:nope', 'box')),
  );

  expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
  expect(String(failure)).toContain('manifest unknown');

  const imps = await listImps(ctx.db);

  expect(imps).toEqual([]);

  const box = await findImageByName(ctx.db, 'box');

  expect(box).toBeUndefined();
  expect(ctx.listWorkDirs()).toEqual([]);
  expect(ctx.readHostCalls()).toBe('');
});

test('an export over IMP_BUILD_IMAGE_MAX_MIB is refused, and leaves nothing behind', async () => {
  await using ctx = await setupAdd({
    env: { IMP_BUILD_IMAGE_MAX_MIB: '1' },
    buildExport: (dir) => [buildTar(dir, { big: 'x'.repeat(2 * 1024 ** 2) })],
  });

  const failure = await readFailure(
    ctx.withHostDocker(() => ctx.addImages.addImage('busybox:1.37', 'box')),
  );

  expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
  expect(String(failure)).toContain('IMP_BUILD_IMAGE_MAX_MIB');

  const imps = await listImps(ctx.db);

  expect(imps).toEqual([]);

  const box = await findImageByName(ctx.db, 'box');

  expect(box).toBeUndefined();
  expect(ctx.listWorkDirs()).toEqual([]);
});

// an image whose /etc/imp/image.json its author made a link to the host path
// `target`, as a registry image may be
function buildLinkedTar(dir: string, target: string): Uint8Array {
  const tree = join(dir, `linked-${Bun.randomUUIDv7()}`);

  mkdirSync(join(tree, 'etc', 'imp'), { recursive: true });
  rmSync(join(tree, 'etc', 'imp', 'image.json'), { force: true });
  symlinkSync(target, join(tree, 'etc', 'imp', 'image.json'));

  return Bun.spawnSync(['tar', '-C', tree, '-c', '.']).stdout;
}

test("an added image's image.json link changes no host file", async () => {
  const canary = { path: '' };

  await using ctx = await setupAdd({
    buildExport: (dir) => {
      canary.path = join(dir, 'canary');

      writeFileSync(canary.path, "the host's\n");

      return [buildLinkedTar(dir, canary.path)];
    },
  });

  const image = await ctx.withHostDocker(() => ctx.addImages.addImage('busybox:1.37', 'box'));

  expect(image.digest).toMatch(/^imp-build-[a-f0-9]{64}$/v);
  expect(readFileSync(canary.path, 'utf8')).toBe("the host's\n");
});

test('a client that goes ends the pull in the builder, and the builder with it', async () => {
  const pulling = Promise.withResolvers<null>();
  const never = Promise.withResolvers<FakeAnswer>();

  await using ctx = await setupAdd({
    onPull: () => {
      pulling.resolve(null);

      return never.promise;
    },
  });

  const controller = new AbortController();

  const adding = readFailure(
    ctx.withHostDocker(() =>
      ctx.addImages.addImage('busybox:1.37', 'box', { signal: controller.signal }),
    ),
  );

  await pulling.promise;

  controller.abort(new Error('the client went'));

  const failure = await adding;

  expect(String(failure)).toContain('the client went');

  // the exec ends, and the builder's removal ends the pull with it
  const pull = ctx.guest.runs.find((run) => run.argv[1] === 'pull');

  expect(pull?.closed).toBe(true);

  const imps = await listImps(ctx.db);

  expect(imps).toEqual([]);

  const box = await findImageByName(ctx.db, 'box');

  expect(box).toBeUndefined();
});

test('a registry on the host itself or at an IP literal is refused before any builder boots', async () => {
  await using ctx = await setupAdd();

  for (const [ref, problem] of [
    [
      '203.0.113.5:5000/x:1',
      'image 203.0.113.5:5000/x:1: registry 203.0.113.5:5000 is an IP address',
    ],
    ['localhost:5000/x:1', "image localhost:5000/x:1: registry localhost:5000 is the host's own"],
    ['registry.localhost/x:1', "registry registry.localhost is the host's own"],

    // a bracketed IPv6 literal is no reference the schema takes
    ['[2001:db8::1]:5000/x:1', 'invalid image reference'],
  ] as const) {
    const failure = await readFailure(ctx.withHostDocker(() => ctx.addImages.addImage(ref, 'box')));

    expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
    expect(String(failure)).toContain(problem);
  }

  const imps = await listImps(ctx.db);

  expect(ctx.guest.runs).toEqual([]);
  expect(imps).toEqual([]);
  expect(ctx.readHostCalls()).toBe('');
});

test('a builder the governor refuses fails the add, with no host engine call', async () => {
  await using ctx = await setupAdd({ env: { IMP_RAM_BUDGET_MIB: '256' } });

  const failure = await readFailure(
    ctx.withHostDocker(() => ctx.addImages.addImage('busybox:1.37', 'box')),
  );

  expect(String(failure)).toContain('the whole RAM budget');
  expect(ctx.guest.runs).toEqual([]);
  expect(ctx.readHostCalls()).toBe('');

  const box = await findImageByName(ctx.db, 'box');

  expect(box).toBeUndefined();
});

test('a builder image the host engine cannot give fails the add with a clear error, never a host add', async () => {
  await using ctx = await setupAdd({ isRealBuilderImage: true });

  const failure = await readFailure(
    ctx.withHostDocker(() => ctx.addImages.addImage('busybox:1.37', 'box')),
  );

  expect(failure).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  expect(String(failure)).toContain(`impd cannot add its builder image ${ctx.config.build.image}`);

  // the only host calls are for the builder image, by its digest
  const calls = ctx.readHostCalls().trim().split('\n');

  expect(calls.every((call) => call.endsWith(ctx.config.build.image))).toBe(true);
  expect(ctx.guest.runs).toEqual([]);

  const imps = await listImps(ctx.db);

  expect(imps).toEqual([]);
});

// The host engine as the proxy's lock leaves it: the builder image pulls by
// its digest, and create and export serve a small tree
function buildBuilderHost(dataDir: string, pull = 'touch "$pulled"; exit 0'): string {
  const tar = join(dataDir, 'builder.tar');

  writeFileSync(tar, buildTar(dataDir, { dockerd: 'builder\n' }));

  const inspect = JSON.stringify([{ Id: `sha256:${'f'.repeat(64)}`, Config: {}, Size: 4096 }]);

  return [
    `pulled='${dataDir}/pulled'`,
    'case "$1 $2" in',
    `  "image inspect") [ -f "$pulled" ] && { echo '${inspect}'; exit 0; } ;;`,
    `  "pull --quiet") ${pull} ;;`,
    `  "create "*) echo '${CONTAINER_ID}'; exit 0 ;;`,
    `  "export "*) cat '${tar}'; exit 0 ;;`,
    '  "rm -f") exit 0 ;;',
    'esac',
  ].join('\n');
}

test('an IMP_BUILD_IMAGE bump adds the new builder image once, by its digest, and moves the row', async () => {
  await using ctx = await setupAdd({ hostDocker: buildBuilderHost });

  // the builder image of an older release
  await ctx.createTestImage(BUILDER_IMAGE);

  // what each add and build calls first; the second finds the row current
  await ctx.withHostDocker(() => ctx.addImages.ensureBuilderImage());
  await ctx.withHostDocker(() => ctx.addImages.ensureBuilderImage());

  const builder = await findImageByName(ctx.db, BUILDER_IMAGE);

  expect(builder).toMatchObject({
    ref: ctx.config.build.image,
    digest: `sha256:${'f'.repeat(64)}`,
  });

  const pulls = ctx
    .readHostCalls()
    .split('\n')
    .filter((call) => call.startsWith('pull '));

  expect(pulls).toEqual([`pull --quiet ${ctx.config.build.image}`]);
});

test('the first-start seed goes through a builder too', async () => {
  await using ctx = await setupAdd();

  // the harness's own images, so the seed has none
  for (const name of ['base']) {
    await ctx.db.deleteFrom('images').where('name', '=', name).execute();
  }

  await ctx.withHostDocker(() => ctx.addImages.seedDefaultImage());

  const seeded = await findImageByName(ctx.db, 'ubuntu');

  expect(seeded).toMatchObject({ ref: 'ubuntu:24.04' });
  expect(ctx.readHostCalls()).toBe('');

  const commands = ctx.guest.runs.map((run) => run.argv.slice(1).join(' '));

  expect(commands).toContain('pull --quiet --platform linux/amd64 ubuntu:24.04');
});

test('IMP_BUILD_ISOLATION=host adds on the host engine, as before, with a warning and no builder', async () => {
  await using ctx = await setupAdd({ env: { IMP_BUILD_ISOLATION: 'host' } });

  const failure = await readFailure(
    ctx.withHostDocker(() => ctx.addImages.addImage('busybox:1.37', 'box')),
  );

  // the fake host docker fails every call
  expect(failure).toBeInstanceOf(Error);
  expect(ctx.readHostCalls()).toContain('image inspect busybox:1.37');
  expect(ctx.logs).toContain(HOST_ADD_WARNING);
  expect(ctx.guest.runs).toEqual([]);
});

// a pull that never ends: exec, so the timeout's kill reaches it
const HANG = 'exec sleep 30';

test('a builder image pull that hangs fails at its timeout, naming IMP_BUILD_IMAGE', async () => {
  await using ctx = await setupAdd({
    hostDocker: (dataDir) => buildBuilderHost(dataDir, HANG),
    builderImagePullMs: 300,
  });

  const started = performance.now();

  const failure = await readFailure(ctx.withHostDocker(() => ctx.addImages.ensureBuilderImage()));

  expect(performance.now() - started).toBeLessThan(5000);
  expect(failure).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

  expect(String(failure)).toContain(
    `impd cannot add its builder image ${ctx.config.build.image} (IMP_BUILD_IMAGE)`,
  );

  expect(String(failure)).toContain(
    `the pull did not finish in 0.3 s; on a slow link, pull ${ctx.config.build.image} on the host engine first (docker pull ${ctx.config.build.image})`,
  );

  // the inspect that found no image, then the pull: nothing else on the host
  expect(ctx.readHostCalls().trim().split('\n')).toEqual([
    `image inspect ${ctx.config.build.image}`,
    `pull --quiet ${ctx.config.build.image}`,
  ]);
});

test('an add after a failed builder image pull pulls again', async () => {
  // the first pull hangs, the second succeeds
  const pull =
    'if [ -f "$pulled.tried" ]; then touch "$pulled"; exit 0; fi; touch "$pulled.tried"; exec sleep 30';

  await using ctx = await setupAdd({
    hostDocker: (dataDir) => buildBuilderHost(dataDir, pull),
    builderImagePullMs: 1000,
  });

  const first = await readFailure(ctx.withHostDocker(() => ctx.addImages.ensureBuilderImage()));

  expect(String(first)).toContain('the pull did not finish');

  await ctx.withHostDocker(() => ctx.addImages.ensureBuilderImage());

  const builder = await findImageByName(ctx.db, BUILDER_IMAGE);

  const pulls = ctx
    .readHostCalls()
    .split('\n')
    .filter((call) => call.startsWith('pull '));

  expect(builder).toMatchObject({ ref: ctx.config.build.image });
  expect(pulls).toHaveLength(2);
});

test('a caller that goes stops waiting, and the pull it shared goes on for the others', async () => {
  const go = { path: '' };

  await using ctx = await setupAdd({
    hostDocker: (dataDir) => {
      go.path = join(dataDir, 'go');

      return buildBuilderHost(
        dataDir,
        `while [ ! -f '${go.path}' ]; do sleep 0.05; done; touch "$pulled"; exit 0`,
      );
    },
  });

  const controller = new AbortController();

  // one PATH for both callers: each call's own would restore it as it ends
  await ctx.withHostDocker(async () => {
    const leaving = readFailure(ctx.addImages.ensureBuilderImage(controller.signal));
    const staying = ctx.addImages.ensureBuilderImage();

    controller.abort(new Error('the client went'));

    const left = await leaving;

    expect(String(left)).toContain('the client went');

    writeFileSync(go.path, '');

    await staying;
  });

  const builder = await findImageByName(ctx.db, BUILDER_IMAGE);

  const pulls = ctx
    .readHostCalls()
    .split('\n')
    .filter((call) => call.startsWith('pull '));

  expect(builder).toMatchObject({ ref: ctx.config.build.image });
  expect(pulls).toHaveLength(1);
});

test('a builder image the host engine has already, pulled ahead by its reference, is not pulled', async () => {
  await using ctx = await setupAdd({
    hostDocker: (dataDir) => {
      // the operator's own `docker pull` of IMP_BUILD_IMAGE
      writeFileSync(join(dataDir, 'pulled'), '');

      return buildBuilderHost(dataDir, HANG);
    },
    builderImagePullMs: 300,
  });

  await ctx.withHostDocker(() => ctx.addImages.ensureBuilderImage());

  const builder = await findImageByName(ctx.db, BUILDER_IMAGE);

  const pulls = ctx
    .readHostCalls()
    .split('\n')
    .filter((call) => call.startsWith('pull '));

  expect(builder).toMatchObject({ ref: ctx.config.build.image });
  expect(pulls).toEqual([]);
});

test('a step after the pull that fails past the limit names its own error, not the pull', async () => {
  const create = `  "create "*) sleep 0.6; echo 'no space left on device' >&2; exit 1 ;;`;

  await using ctx = await setupAdd({
    hostDocker: (dataDir) => buildBuilderHost(dataDir).replace(/^ {2}"create "\*\).*$/mv, create),
    builderImagePullMs: 300,
  });

  const failure = await readFailure(ctx.withHostDocker(() => ctx.addImages.ensureBuilderImage()));

  expect(failure).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  expect(String(failure)).toContain('no space left on device');
  expect(String(failure)).not.toContain('the pull did not finish');
});

// a template row named `name`, as an imp's image would be
function createTemplateRow(db: Parameters<typeof createImage>[0], name: string) {
  return createImage(db, {
    name,
    ref: 'imp:dev',
    digest: `sha256:${'d'.repeat(64)}`,
    sizeBytes: 1,
    source: 'imp',
    sourceImp: 'dev',
  });
}

test('a client that leaves an add while mkfs.ext4 runs leaves no row, no rootfs and no hold', async () => {
  await using ctx = await setupAdd({ pauseMkfs: true });

  const controller = new AbortController();

  const failure = await ctx.withHostDocker(async () => {
    const adding = readFailure(
      ctx.addImages.addImage('busybox:1.37', 'box', { signal: controller.signal }),
    );

    await ctx.waitForMkfs();

    controller.abort(new Error('the client went'));
    ctx.startMkfs();

    return adding;
  });

  const box = await findImageByName(ctx.db, 'box');
  const status = await ctx.diskBudget.readStatus();
  const imps = await listImps(ctx.db);

  expect(String(failure)).toContain('the client went');
  expect(box).toBeUndefined();
  expect(ctx.listBuiltRootfs()).toEqual([]);
  expect(status.pendingBytes).toBe(0);
  expect(imps).toEqual([]);
});

test('a template that takes the name during an add leaves no new row and no rootfs', async () => {
  const holder: { db?: Parameters<typeof createImage>[0] } = {};

  await using ctx = await setupAdd({
    onExport: async () => {
      if (holder.db !== undefined) {
        await createTemplateRow(holder.db, 'box');
      }
    },
  });

  holder.db = ctx.db;

  const failure = await readFailure(
    ctx.withHostDocker(() => ctx.addImages.addImage('busybox:1.37', 'box')),
  );

  const box = await findImageByName(ctx.db, 'box');
  const status = await ctx.diskBudget.readStatus();

  expect(String(failure)).toContain('image box is a template');
  expect(box).toMatchObject({ source: 'imp' });
  expect(ctx.listBuiltRootfs()).toEqual([]);
  expect(status.pendingBytes).toBe(0);
});

test("an add and a build of one digest at once: one row fails, the other's row and rootfs stay", async () => {
  await using ctx = await setupAdd({ pauseMkfs: true });

  // one PATH for both callers: each call's own would restore it as it ends
  const [failure, built] = await ctx.withHostDocker(async () => {
    const adding = readFailure(ctx.addImages.addImage('busybox:1.37', 'box'));
    const building = ctx.runBuild('web');

    // both exports are in, so both wait on the one mkfs.ext4
    await ctx.waitForMkfs();

    while (ctx.guest.runs.filter((run) => run.argv[1] === 'export' && run.closed).length < 2) {
      await Bun.sleep(20);
    }

    await Bun.sleep(200);

    await createTemplateRow(ctx.db, 'box');

    ctx.startMkfs();

    return Promise.all([adding, building]);
  });

  const status = await ctx.diskBudget.readStatus();

  expect(String(failure)).toContain('image box is a template');
  expect(built).toMatchObject({ name: 'web' });
  expect(ctx.listBuiltRootfs()).toEqual([built.digest]);
  expect(existsSync(buildImagePaths(ctx.dataDir, built.digest).rootfs)).toBe(true);
  expect(status.pendingBytes).toBe(0);
});

// An add of `one`'s digest held between finding its rootfs and writing its
// row while `imp image rm one` runs; `isRowFailing` makes that row fail too
async function runRemoveDuringAdd(isRowFailing: boolean) {
  const exports = { count: 0 };
  const holder: { arm?: () => void } = {};

  // the second add's export arms the gate, after its name check
  const ctx = await setupAdd({
    gatedName: 'box',
    onExport: () => {
      exports.count += 1;

      if (exports.count === 2) {
        holder.arm?.();
      }

      return Promise.resolve();
    },
  });

  holder.arm = ctx.gate.arm;

  const first = await ctx.withHostDocker(() => ctx.addImages.addImage('busybox:1.37', 'one'));

  const end = await ctx.withHostDocker(async () => {
    const adding = readFailure(ctx.addImages.addImage('busybox:1.37', 'box'));

    await ctx.gate.reached;

    await ctx.addImages.removeImage('one');

    if (isRowFailing) {
      await createTemplateRow(ctx.db, 'box');
    }

    ctx.gate.release();

    return adding;
  });

  const rows = await listImages(ctx.db);

  const hasRootfs = existsSync(buildImagePaths(ctx.dataDir, first.digest).rootfs);

  await ctx[Symbol.asyncDispose]();

  return {
    end,
    rows: rows
      .filter((row) => ['one', 'box'].includes(row.name))
      .map((row) => [row.name, row.digest]),
    hasRootfs,
    first,
  };
}

test('an image rm while an add of its digest sits between its rootfs and its row keeps that rootfs', async () => {
  const kept = await runRemoveDuringAdd(false);

  expect(kept.end).toBeNull();
  expect(kept.rows).toEqual([['box', kept.first.digest]]);
  expect(kept.hasRootfs).toBe(true);
});

test("that rootfs goes after all when the add's row then fails", async () => {
  const failed = await runRemoveDuringAdd(true);

  expect(String(failed.end)).toContain('UNIQUE');
  expect(failed.rows).toEqual([['box', `sha256:${'d'.repeat(64)}`]]);
  expect(failed.hasRootfs).toBe(false);
});

test('a cleanup removal that fails is logged, and the add returns its own error', async () => {
  const holder: { db?: Parameters<typeof createImage>[0] } = {};

  await using ctx = await setupAdd({
    isRemoveFailing: true,
    onExport: async () => {
      if (holder.db !== undefined) {
        await createTemplateRow(holder.db, 'box');
      }
    },
  });

  holder.db = ctx.db;

  const failure = await readFailure(
    ctx.withHostDocker(() => ctx.addImages.addImage('busybox:1.37', 'box')),
  );

  expect(String(failure)).toContain('image box is a template');

  expect(ctx.logs.join('\n')).toContain(
    'impd: image box: could not remove the unused rootfs of imp-build-',
  );

  expect(ctx.logs.join('\n')).toContain('the disk is read-only');
});
