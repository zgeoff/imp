import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KyselyPlugin } from 'kysely';
import { loadConfig } from '../config';
import { createImage, findImageByName, listImages } from '../db/images';
import { openDatabase } from '../db/open-database';
import { readRejection } from '../read-rejection';
import { buildImagePaths } from '../storage/data-layout';
import { createDiskBudget } from '../storage/disk-budget';
import type { StorageBackend } from '../storage/storage-backend';
import { createStorageGate } from '../storage/storage-gate';
import { createXfsBackend } from '../storage/xfs-backend';
import type { Builders } from './builder-imps';
import { createFakeGuest } from './fake-guest';
import type { FakeAnswer, FakeRun } from './fake-guest';
import { createGuestExec } from './guest-exec';
import { PIN_INSPECT_FORMAT } from './image-pin';
import { createImageService } from './image-service';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'imp-isolated-build-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const CONTAINER_ID = 'd'.repeat(64);
const CONFIG = '{"Cmd":["/bin/sh"],"Env":["PATH=/bin"]}';

// a tar of a directory holding these files
function buildTar(files: Readonly<Record<string, string>>): Uint8Array {
  const tree = join(dir, `tree-${Bun.randomUUIDv7()}`);

  mkdirSync(tree);

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(tree, name), content);
  }

  return Bun.spawnSync(['tar', '-C', tree, '-c', ...Object.keys(files)]).stdout;
}

// A builder's engine on amd64 that has base.test/a:1 and the frontend, and
// builds whatever it gets; the Dockerfile each build got
function createBuilderAnswer(
  onBuild: (dockerfile: string) => void,
  exported: Uint8Array,
  stall: boolean,
  onExport: () => Promise<void>,
) {
  return async (run: FakeRun): Promise<FakeAnswer> => {
    const argv = run.argv.slice(1).join(' ');

    if (argv.startsWith('version ')) {
      return { stdout: '"linux" "x86_64"\n' };
    }

    if (argv === `image inspect --format ${PIN_INSPECT_FORMAT} base.test/a:1`) {
      const inspect = {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`base.test/a@${DIGEST_A}`],
        Os: 'linux',
        Architecture: 'amd64',
        Config: {},
      };

      return { stdout: JSON.stringify(inspect) };
    }

    if (argv.startsWith('image inspect --format {{.Id}} docker/dockerfile')) {
      return { stdout: `sha256:${'f'.repeat(64)}\n` };
    }

    if (argv.startsWith('build ')) {
      const context = await run.readStdin();

      const dockerfile = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], { stdin: context });

      onBuild(new TextDecoder().decode(dockerfile.stdout));

      return { stderr: '#1 DONE\n' };
    }

    if (argv === 'image inspect --format {{json .Config}} imp-build:latest') {
      return { stdout: CONFIG };
    }

    if (argv === 'create imp-build:latest /bin/true') {
      return { stdout: `${CONTAINER_ID}\n` };
    }

    if (argv === `export ${CONTAINER_ID}`) {
      await onExport();

      return { stdout: [exported], stall };
    }

    return { code: 1, stderr: `the fake builder has no ${argv}` };
  };
}

// Holds the result of the first select that names `name` once armed, until
// released: a build stops there between finding its rootfs and its row.
function createQueryGate(name: string) {
  const state = { armed: false, held: new Set<unknown>() };
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();

  const plugin: KyselyPlugin = {
    transformQuery: (args) => {
      const isNamed =
        args.node.kind === 'SelectQueryNode' && JSON.stringify(args.node).includes(`"${name}"`);

      if (state.armed && isNamed) {
        state.armed = false;

        state.held.add(args.queryId);
      }

      return args.node;
    },
    transformResult: async (args) => {
      if (state.held.has(args.queryId)) {
        reached.resolve();

        await released.promise;
      }

      return args.result;
    },
  };

  return {
    plugin,
    arm: () => {
      state.armed = true;
    },
    reached: reached.promise,
    release: () => {
      released.resolve();
    },
  };
}

interface IsolatedBuildOptions {
  // the builder's export, by default a tree with one file
  readonly exported?: Uint8Array;

  // the free disk above the reserve; IMP_* settings; an export that never ends
  readonly roomBytes?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly stallExport?: boolean;

  // runs as the export starts; mkfs.ext4 waits for startMkfs
  readonly onExport?: () => Promise<void>;
  readonly pauseMkfs?: boolean;

  // a select of this name the gate can hold; a rootfs write that fails once
  // published
  readonly gatedName?: string;
  readonly failAfterPublish?: boolean;
}

async function setupIsolatedBuild(options: Readonly<IsolatedBuildOptions> = {}) {
  const exported = options.exported ?? buildTar({ hello: 'from the builder\n' });

  // one directory per setup, so a test may set up twice
  const home = join(dir, `setup-${Bun.randomUUIDv7()}`);
  const dataDir = join(home, 'data');

  mkdirSync(dataDir, { recursive: true });

  const db = await openDatabase(':memory:');

  const builtDockerfiles: string[] = [];

  const guest = createFakeGuest(
    createBuilderAnswer(
      (dockerfile) => {
        builtDockerfiles.push(dockerfile);
      },
      exported,
      options.stallExport === true,
      options.onExport ?? (() => Promise.resolve()),
    ),
  );

  const boots: string[] = [];
  const grows: number[] = [];
  const live = { builders: 0 };
  const usage = { usedBytes: 0, availableBytes: options.roomBytes ?? 1024 ** 5 };

  const diskBudget = createDiskBudget({
    storage: { readUsage: () => Promise.resolve(usage) },
    reserveBytes: 0,
    log: () => {},
  });

  const builders: Builders = {
    withBuilder: async (_signal, run) => {
      boots.push('builder');

      live.builders += 1;

      try {
        return await run(createGuestExec(guest.open));
      } finally {
        live.builders -= 1;
      }
    },
    removeLeftovers: () => Promise.resolve(),
  };

  // a host docker that logs every call: an isolated build makes none
  const bin = join(home, 'bin');
  const hostLog = join(home, 'host-docker.log');

  mkdirSync(bin);

  writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$*" >>'${hostLog}'\nexit 1\n`, {
    mode: 0o755,
  });

  const mkfsStarted = join(home, 'mkfs-started');
  const mkfsReleased = join(home, 'mkfs-released');

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
  const xfs = createXfsBackend({ dataDir });

  const storage: StorageBackend =
    options.failAfterPublish === true
      ? {
          ...xfs,
          createImage: async (digest, write) => {
            await xfs.createImage(digest, write);

            throw new Error('the mount failed');
          },
        }
      : xfs;

  const images = createImageService({
    config: loadConfig({ ...options.env, IMP_DATA_DIR: dataDir }),
    db: db.withPlugin(gate.plugin),
    storage,
    storageGate: createStorageGate(),
    diskBudget: {
      withRoom: diskBudget.withRoom,
      withGrowingRoom: (task) =>
        diskBudget.withGrowingRoom((grow) =>
          task(async (totalBytes) => {
            grows.push(totalBytes);

            await grow(totalBytes);
          }),
        ),
    },
    readBuilders: () => builders,
    log: () => {},
  });

  // bin leads PATH while any build of this setup runs
  const paths = { users: 0, saved: process.env['PATH'] };

  const runBuild = async (
    dockerfile: string,
    signal = new AbortController().signal,
    name = 'web',
  ) => {
    const tarPath = join(dir, `context-${Bun.randomUUIDv7()}.tar`);

    writeFileSync(tarPath, buildTar({ Dockerfile: dockerfile }));

    if (paths.users === 0) {
      paths.saved = process.env['PATH'];
      process.env['PATH'] = `${bin}:${paths.saved ?? ''}`;
    }

    paths.users += 1;

    try {
      return await images.buildImageFromContext(tarPath, name, undefined, signal);
    } finally {
      paths.users -= 1;

      if (paths.users === 0) {
        process.env['PATH'] = paths.saved;
      }
    }
  };

  const readHostCalls = () => (existsSync(hostLog) ? readFileSync(hostLog, 'utf8') : '');

  return {
    db,
    dataDir,
    guest,
    builtDockerfiles,
    exported,
    boots,
    grows,
    live,
    images,
    gate,
    diskBudget,
    waitForMkfs,
    startMkfs,
    runBuild,
    readHostCalls,
  };
}

test('an isolated build pins, builds and exports in its builder, and the host engine sees none of it', async () => {
  const ctx = await setupIsolatedBuild();
  const image = await ctx.runBuild('FROM base.test/a:1\nRUN true\n');

  // the digest's own form: no Docker image ID is one
  expect(image).toMatchObject({ name: 'web', ref: 'imp/web:latest' });
  expect(image.digest).toMatch(/^imp-build-[a-f0-9]{64}$/v);

  const saved = await findImageByName(ctx.db, 'web');

  expect(saved).toMatchObject({ digest: image.digest });
  expect(existsSync(buildImagePaths(ctx.dataDir, image.digest).rootfs)).toBe(true);
  expect(ctx.builtDockerfiles).toEqual([`FROM base.test/a@${DIGEST_A}\nRUN true\n`]);
  expect(ctx.readHostCalls()).toBe('');

  expect(ctx.guest.runs.map((run) => run.argv.slice(1, 3).join(' '))).toEqual([
    'version --format',
    'image inspect',
    'image inspect',
    'build --progress=plain',
    'image inspect',
    'create imp-build:latest',
    `export ${CONTAINER_ID}`,
  ]);
});

test('an isolated build holds disk as its export grows, not the image cap, and stops where the disk does', async () => {
  const small = await setupIsolatedBuild();

  await small.runBuild('FROM base.test/a:1\nRUN true\n');

  // one 256 MiB step, where the cap would hold 16 GiB
  expect(small.grows).toEqual([256 * 1024 ** 2]);

  const big = await setupIsolatedBuild({
    exported: buildTar({ big: 'x'.repeat(200 * 1024 ** 2) }),
    roomBytes: 256 * 1024 ** 2,
  });

  const failure = await big
    .runBuild('FROM base.test/a:1\nRUN true\n')
    .catch((error: unknown) => error);

  expect(failure).toMatchObject({ code: 'DISK_FULL' });

  // the fake builder sends its export as one chunk
  expect(big.grows).toEqual([512 * 1024 ** 2]);
  expect(big.guest.runs.at(-1)).toMatchObject({ closed: true });
});

test("an isolated build's disk hold goes however the build ends", async () => {
  const dockerfile = 'FROM base.test/a:1\nRUN true\n';
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`f${String(n)}`, 'x']));

  const built = await setupIsolatedBuild();

  const limited = await setupIsolatedBuild({
    exported: buildTar(many),
    env: { IMP_BUILD_IMAGE_MAX_FILES: '5' },
  });

  const full = await setupIsolatedBuild({
    exported: buildTar({ big: 'x'.repeat(200 * 1024 ** 2) }),
    roomBytes: 256 * 1024 ** 2,
  });

  const cancelled = await setupIsolatedBuild({ stallExport: true });

  const client = new AbortController();

  await built.runBuild(dockerfile);

  const ends = [
    await limited.runBuild(dockerfile).catch((error: unknown) => error),
    await full.runBuild(dockerfile).catch((error: unknown) => error),
  ];

  // the client goes while the builder holds its export open
  const cancelling = readRejection(cancelled.runBuild(dockerfile, client.signal));

  await Bun.sleep(100);

  client.abort();

  const cancelEnd = await cancelling;

  expect(String(ends[0])).toContain('is over 5 files');
  expect(ends[1]).toMatchObject({ code: 'DISK_FULL' });
  expect(cancelEnd).toBeInstanceOf(Error);

  for (const ctx of [built, limited, full, cancelled]) {
    const status = await ctx.diskBudget.readStatus();

    expect({ grows: ctx.grows.length > 0, pending: status.pendingBytes }).toEqual({
      grows: true,
      pending: 0,
    });
  }
});

// the rootfs directories of builds in the data dir
function listBuiltRootfs(dataDir: string): string[] {
  const images = join(dataDir, 'images');

  return existsSync(images)
    ? readdirSync(images).filter((entry) => entry.startsWith('imp-build-'))
    : [];
}

test('a template that takes the name during the build leaves no new row and no rootfs', async () => {
  const holder: { db?: Awaited<ReturnType<typeof openDatabase>> } = {};

  const ctx = await setupIsolatedBuild({
    onExport: async () => {
      if (holder.db !== undefined) {
        await createImage(holder.db, {
          name: 'web',
          ref: 'imp:dev',
          digest: `sha256:${'b'.repeat(64)}`,
          sizeBytes: 1,
          source: 'imp',
          sourceImp: 'dev',
        });
      }
    },
  });

  holder.db = ctx.db;

  const failure = await readRejection(ctx.runBuild('FROM base.test/a:1\nRUN true\n'));
  const rows = await listImages(ctx.db);
  const status = await ctx.diskBudget.readStatus();

  expect(String(failure)).toContain('image web is a template');
  expect(rows.map((row) => [row.name, row.source])).toEqual([['web', 'imp']]);
  expect(listBuiltRootfs(ctx.dataDir)).toEqual([]);
  expect(status.pendingBytes).toBe(0);
});

test('a build whose row fails keeps the rootfs another build of the digest is writing', async () => {
  const ctx = await setupIsolatedBuild({ pauseMkfs: true });

  const dockerfile = 'FROM base.test/a:1\nRUN true\n';
  const failing = readRejection(ctx.runBuild(dockerfile));
  const kept = ctx.runBuild(dockerfile, new AbortController().signal, 'web2');

  // both exports are in, so both builds wait on the one mkfs.ext4
  await ctx.waitForMkfs();

  while (ctx.guest.runs.filter((run) => run.argv[1] === 'export' && run.closed).length < 2) {
    await Bun.sleep(20);
  }

  await Bun.sleep(200);

  await createImage(ctx.db, {
    name: 'web',
    ref: 'imp:dev',
    digest: `sha256:${'b'.repeat(64)}`,
    sizeBytes: 1,
    source: 'imp',
    sourceImp: 'dev',
  });

  ctx.startMkfs();

  const failure = await failing;
  const image = await kept;

  expect(String(failure)).toContain('image web is a template');
  expect(image).toMatchObject({ name: 'web2' });
  expect(existsSync(buildImagePaths(ctx.dataDir, image.digest).rootfs)).toBe(true);
});

// A build of web's digest held between finding its rootfs and writing its
// row while `imp image rm web` runs; `failRow` makes that row fail too
async function runRemoveDuringRow(failRow: boolean) {
  const exports = { count: 0 };
  const holder: { arm?: () => void } = {};

  // the second build's export arms the gate, after its name check
  const ctx = await setupIsolatedBuild({
    gatedName: 'web2',
    onExport: () => {
      exports.count += 1;

      if (exports.count === 2) {
        holder.arm?.();
      }

      return Promise.resolve();
    },
  });

  holder.arm = ctx.gate.arm;

  const dockerfile = 'FROM base.test/a:1\nRUN true\n';

  const first = await ctx.runBuild(dockerfile);

  const second = readRejection(ctx.runBuild(dockerfile, new AbortController().signal, 'web2'));

  await ctx.gate.reached;

  await ctx.images.removeImage('web');

  if (failRow) {
    await createImage(ctx.db, {
      name: 'web2',
      ref: 'imp:dev',
      digest: `sha256:${'b'.repeat(64)}`,
      sizeBytes: 1,
      source: 'imp',
      sourceImp: 'dev',
    });
  }

  ctx.gate.release();

  const end = await second;
  const rows = await listImages(ctx.db);

  const rootfs = buildImagePaths(ctx.dataDir, first.digest).rootfs;

  return {
    end,
    rows: rows.map((row) => [row.name, row.digest]),
    hasRootfs: existsSync(rootfs),
    first,
  };
}

test('an image rm while a build of its digest is between its rootfs and its row keeps that rootfs', async () => {
  const kept = await runRemoveDuringRow(false);

  expect(kept.end).toBeNull();
  expect(kept.rows).toEqual([['web2', kept.first.digest]]);
  expect(kept.hasRootfs).toBe(true);
});

test("that rootfs goes after all when the build's row then fails", async () => {
  const failed = await runRemoveDuringRow(true);

  expect(failed.end).toBeInstanceOf(Error);
  expect(failed.rows).toEqual([['web2', `sha256:${'b'.repeat(64)}`]]);
  expect(failed.hasRootfs).toBe(false);
});

test('a rootfs whose write fails after it is published goes with the build', async () => {
  const ctx = await setupIsolatedBuild({ failAfterPublish: true });
  const failure = await readRejection(ctx.runBuild('FROM base.test/a:1\nRUN true\n'));
  const rows = await listImages(ctx.db);

  expect(String(failure)).toContain('the mount failed');
  expect(rows).toEqual([]);
  expect(listBuiltRootfs(ctx.dataDir)).toEqual([]);
});

test('a client that goes while mkfs.ext4 runs leaves no row and no rootfs', async () => {
  const ctx = await setupIsolatedBuild({ pauseMkfs: true });

  const client = new AbortController();

  const building = readRejection(ctx.runBuild('FROM base.test/a:1\nRUN true\n', client.signal));

  await ctx.waitForMkfs();

  client.abort();
  ctx.startMkfs();

  const failure = await building;
  const rows = await listImages(ctx.db);
  const status = await ctx.diskBudget.readStatus();

  expect(failure).toBeInstanceOf(Error);
  expect(rows).toEqual([]);
  expect(listBuiltRootfs(ctx.dataDir)).toEqual([]);
  expect(status.pendingBytes).toBe(0);
});

test('an export that stalls past a limit ends at once, with its builder and its disk hold', async () => {
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`f${String(n)}`, 'x']));

  const ctx = await setupIsolatedBuild({
    exported: buildTar(many),
    env: { IMP_BUILD_IMAGE_MAX_FILES: '5' },
    stallExport: true,
  });

  const started = performance.now();

  const failure = await readRejection(ctx.runBuild('FROM base.test/a:1\nRUN true\n'));

  const elapsedMs = performance.now() - started;

  const status = await ctx.diskBudget.readStatus();

  expect(String(failure)).toContain('is over 5 files');
  expect(elapsedMs).toBeLessThan(5000);
  expect(ctx.live.builders).toBe(0);
  expect(ctx.guest.runs.at(-1)).toMatchObject({ closed: true });
  expect(status.pendingBytes).toBe(0);
});

test('a Dockerfile the input guard refuses boots no builder', async () => {
  const ctx = await setupIsolatedBuild();

  const failure = await ctx
    .runBuild('FROM base.test/a:1\nADD https://example.com/x /x\n')
    .catch((error: unknown) => error);

  expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
  expect(ctx.boots).toEqual([]);
  expect(ctx.guest.runs).toEqual([]);
});

// an export whose /etc/imp, or the image.json in it, a RUN step made a link
// to the host path `target`
function buildLinkedExport(linked: 'etc/imp' | 'etc/imp/image.json', target: string): Uint8Array {
  const tree = join(dir, `tree-${Bun.randomUUIDv7()}`);

  mkdirSync(join(tree, 'etc', 'imp'), { recursive: true });
  rmSync(join(tree, linked), { recursive: true, force: true });
  symlinkSync(target, join(tree, linked));

  return Bun.spawnSync(['tar', '-C', tree, '-c', '.']).stdout;
}

test("a built image's image.json link changes no host file", async () => {
  const hostFile = join(dir, 'host-file');
  const hostDir = join(dir, 'host-dir');

  writeFileSync(hostFile, "the host's\n");
  mkdirSync(hostDir);

  const linkedFile = await setupIsolatedBuild({
    exported: buildLinkedExport('etc/imp/image.json', hostFile),
  });

  const image = await linkedFile.runBuild('FROM base.test/a:1\nRUN true\n');

  expect(image.digest).toMatch(/^imp-build-[a-f0-9]{64}$/v);

  const linkedDir = await setupIsolatedBuild({ exported: buildLinkedExport('etc/imp', hostDir) });

  const failure = await linkedDir
    .runBuild('FROM base.test/a:1\nRUN true\n')
    .catch((error: unknown) => error);

  expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
  expect(String(failure)).toContain("the image's /etc/imp is a symlink");
  expect(readFileSync(hostFile, 'utf8')).toBe("the host's\n");
  expect(existsSync(join(hostDir, 'image.json'))).toBe(false);
});
