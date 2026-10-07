import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config';
import { createImage, findImageByName, listImages } from '../db/images';
import { openDatabase } from '../db/open-database';
import { readRejection } from '../read-rejection';
import { buildImagePaths } from '../storage/data-layout';
import { createDiskBudget } from '../storage/disk-budget';
import type { StorageBackend } from '../storage/storage-backend';
import { createStorageGate } from '../storage/storage-gate';
import { createXfsBackend } from '../storage/xfs-backend';
import { createQueryGate } from '../test-utils/build-query-gate';
import { createFakeGuest } from '../test-utils/build-stub-guest';
import type { FakeAnswer, FakeRun } from '../test-utils/build-stub-guest';
import type { Builders } from './builder-imps';
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
  exported: readonly Uint8Array[],
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

      return { stdout: exported, stall };
    }

    return { code: 1, stderr: `the fake builder has no ${argv}` };
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

  // the data dir on this filesystem, whose real free space, less
  // reserveBytes, is the room; the export in chunks of this many bytes, as a
  // builder streams it, else in one
  readonly disk?: { readonly mount: string; readonly reserveBytes: number };
  readonly chunkBytes?: number;

  // runs once each rootfs is written, while its tree is still on disk
  readonly onRootfsWritten?: () => void;
}

// the export in chunks of chunkBytes
function splitChunks(exported: Uint8Array, chunkBytes: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];

  for (let at = 0; at < exported.byteLength; at += chunkBytes) {
    chunks.push(exported.subarray(at, at + chunkBytes));
  }

  return chunks;
}

async function setupIsolatedBuild(options: Readonly<IsolatedBuildOptions> = {}) {
  const exported = options.exported ?? buildTar({ hello: 'from the builder\n' });

  // one directory per setup, so a test may set up twice
  const home = join(dir, `setup-${Bun.randomUUIDv7()}`);
  const disk = options.disk;
  const dataDir = join(disk?.mount ?? home, `data-${Bun.randomUUIDv7()}`);

  mkdirSync(home);
  mkdirSync(dataDir, { recursive: true });

  const db = await openDatabase(':memory:');

  const builtDockerfiles: string[] = [];
  const chunks = splitChunks(exported, options.chunkBytes ?? Math.max(1, exported.byteLength));

  const guest = createFakeGuest(
    createBuilderAnswer(
      (dockerfile) => {
        builtDockerfiles.push(dockerfile);
      },
      chunks,
      options.stallExport === true,
      options.onExport ?? (() => Promise.resolve()),
    ),
  );

  const boots: string[] = [];
  const grows: number[] = [];
  const live = { builders: 0 };
  const usage = { usedBytes: 0, availableBytes: options.roomBytes ?? 1024 ** 5 };
  const xfs = createXfsBackend({ dataDir });

  const diskBudget = createDiskBudget({
    storage: disk === undefined ? { readUsage: () => Promise.resolve(usage) } : xfs,
    reserveBytes: disk?.reserveBytes ?? 0,
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

  const storage: StorageBackend = {
    ...xfs,
    createImage: async (digest, write) => {
      await xfs.createImage(digest, write);

      options.onRootfsWritten?.();

      if (options.failAfterPublish === true) {
        throw new Error('the mount failed');
      }
    },
  };

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
      return await images.buildImageFromContext(tarPath, name, undefined, { signal });
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

  // the fake builder sends its export as one chunk: twice 200 MiB and the
  // rootfs's journal, in 256 MiB steps
  expect(big.grows).toEqual([768 * 1024 ** 2]);
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

// A build's disk hold against what it takes on a real filesystem: a small
// one of its own that IMP_TEST_SMALL_FS names (CI mounts a loop XFS for it;
// docs/architecture/storage.md#disk-budget). Without it these skip.
const SMALL_FS = process.env['IMP_TEST_SMALL_FS'];
const MIB = 1024 ** 2;
const RESERVE_BYTES = 128 * MIB;

// a tar of the tree make() writes, owned by root as an image's files are
function buildTreeTar(make: (tree: string) => void, tarArgs: readonly string[] = []): Uint8Array {
  const tree = join(dir, `tree-${Bun.randomUUIDv7()}`);

  mkdirSync(tree);
  make(tree);

  const tar = Bun.spawnSync(
    ['tar', '--owner=0', '--group=0', '--numeric-owner', ...tarArgs, '-C', tree, '-c', '.'],
    { maxBuffer: 2 * 1024 ** 3 },
  );

  rmSync(tree, { recursive: true, force: true });

  return tar.stdout;
}

interface DiskTrial {
  // the last hold the build asked for
  readonly hold: number;

  // what the build took once its tree and rootfs were both written and
  // synced; the most statfs showed it take, which on XFS adds blocks held for
  // writes not yet flushed, and the least it showed free
  readonly settledBytes: number;
  readonly peakBytes: number;
  readonly lowestFree: number;

  // 'built', or the error's code
  readonly outcome: string;
}

// one build on the small filesystem, sampled as it runs and once its rootfs
// and tree are both on disk; roomBytes fills the filesystem first so that
// this much is free above the reserve
async function runDiskTrial(
  mount: string,
  exported: Uint8Array,
  roomBytes?: number,
): Promise<DiskTrial> {
  const filler = join(mount, `filler-${Bun.randomUUIDv7()}`);
  const seen = { lowestFree: Number.POSITIVE_INFINITY, highestUsed: 0, settledUsed: 0, split: '' };
  const where = { dataDir: '' };

  const readDisk = () => {
    const stats = statfsSync(mount);

    return { free: stats.bavail * stats.bsize, used: (stats.blocks - stats.bfree) * stats.bsize };
  };

  const updateSeen = () => {
    const disk = readDisk();

    seen.lowestFree = Math.min(seen.lowestFree, disk.free);
    seen.highestUsed = Math.max(seen.highestUsed, disk.used);
  };

  // XFS frees a removed file's blocks in the background: wait until free
  // space holds still
  const waitForSettledDisk = () => {
    Bun.spawnSync(['sync', '-f', mount]);

    for (let tries = 0; tries < 50; tries += 1) {
      const before = readDisk().free;

      Bun.sleepSync(200);

      if (readDisk().free === before) {
        return;
      }
    }
  };

  // the blocks of the unpacked tree and of the rootfs, once both are written
  const readSplit = () => {
    const images = join(where.dataDir, 'images');

    const du = Bun.spawnSync([
      'du',
      '-s',
      '-B1',
      ...readdirSync(images).map((entry) => join(images, entry)),
    ]);

    seen.split = new TextDecoder()
      .decode(du.stdout)
      .trim()
      .split('\n')
      .map((line) => {
        const [bytes, path] = line.split('\t');
        const kind = (path ?? '').includes('/.build-') ? 'tree' : 'rootfs';

        return `${kind} ${(Number(bytes) / MIB).toFixed(1)} MiB`;
      })
      .join(', ');
  };

  const ctx = await setupIsolatedBuild({
    exported,
    chunkBytes: MIB,
    disk: { mount, reserveBytes: RESERVE_BYTES },
    onRootfsWritten: () => {
      updateSeen();

      Bun.spawnSync(['sync', '-f', mount]);

      seen.settledUsed = readDisk().used;

      readSplit();
    },
  });

  where.dataDir = ctx.dataDir;

  // the filler and the data dir go however the trial ends
  try {
    waitForSettledDisk();

    if (roomBytes !== undefined) {
      const fill = readDisk().free - RESERVE_BYTES - roomBytes;

      Bun.spawnSync(['fallocate', '-l', String(fill), filler]);

      waitForSettledDisk();
    }

    const baseUsed = readDisk().used;
    const timer = setInterval(updateSeen, 1);

    try {
      const outcome = await ctx.runBuild('FROM base.test/a:1\nRUN true\n').then(
        () => 'built',
        (error: unknown) =>
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : String(error),
      );

      updateSeen();

      const trial = {
        hold: ctx.grows.at(-1) ?? 0,
        settledBytes: seen.settledUsed === 0 ? 0 : seen.settledUsed - baseUsed,
        peakBytes: seen.highestUsed - baseUsed,
        lowestFree: seen.lowestFree,
        outcome,
      };

      const formatMib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;

      console.log(
        `disk trial: ${String(exported.byteLength)} B export, hold ${formatMib(trial.hold)}, settled use ${formatMib(trial.settledBytes)}, peak use ${formatMib(trial.peakBytes)}, lowest free ${formatMib(trial.lowestFree)}, ${outcome} (${seen.split})`,
      );

      return trial;
    } finally {
      clearInterval(timer);
    }
  } finally {
    rmSync(ctx.dataDir, { recursive: true, force: true });
    rmSync(filler, { force: true });
    waitForSettledDisk();
  }
}

// a trial of tens of thousands of files runs past bun's 5 s default
function registerSmallFsTest(name: string, run: () => Promise<void>) {
  test.skipIf(SMALL_FS === undefined)(name, run, 120_000);
}

// what it took fits in what it held, and free space never went under the reserve
function assertWithinHold(trial: DiskTrial) {
  expect(trial.outcome).toBe('built');
  expect(trial.settledBytes).toBeLessThanOrEqual(trial.hold);
  expect(trial.lowestFree).toBeGreaterThanOrEqual(RESERVE_BYTES);
}

registerSmallFsTest(
  'on a small filesystem, a one-file image takes no more than its hold',
  async () => {
    const trial = await runDiskTrial(
      SMALL_FS ?? '',
      buildTreeTar((tree) => {
        writeFileSync(join(tree, 'hello'), 'from the builder\n');
      }),
    );

    assertWithinHold(trial);
  },
);

registerSmallFsTest(
  'on a small filesystem, many empty files take no more than their hold',
  async () => {
    const trial = await runDiskTrial(
      SMALL_FS ?? '',
      buildTreeTar((tree) => {
        for (let d = 0; d < 30; d += 1) {
          mkdirSync(join(tree, `d${String(d)}`));

          for (let n = 0; n < 1000; n += 1) {
            writeFileSync(join(tree, `d${String(d)}`, `f${String(n)}`), '');
          }
        }
      }),
    );

    assertWithinHold(trial);
  },
);

registerSmallFsTest('on a small filesystem, a deep tree takes no more than its hold', async () => {
  const trial = await runDiskTrial(
    SMALL_FS ?? '',
    buildTreeTar((tree) => {
      for (let chain = 0; chain < 300; chain += 1) {
        mkdirSync(join(tree, `c${String(chain)}`, ...Array.from({ length: 40 }, () => 'd')), {
          recursive: true,
        });
      }
    }),
  );

  assertWithinHold(trial);
});

registerSmallFsTest(
  'on a small filesystem, a sparse file takes no more than its hold',
  async () => {
    const writeSparse = (tree: string) => {
      const file = join(tree, 'sparse');

      writeFileSync(file, 'x'.repeat(MIB));

      Bun.spawnSync(['truncate', '-s', String(400 * MIB), file]);
    };

    // stored in full, as docker export sends it, and as a GNU sparse member
    const full = await runDiskTrial(SMALL_FS ?? '', buildTreeTar(writeSparse));
    const holes = await runDiskTrial(SMALL_FS ?? '', buildTreeTar(writeSparse, ['--sparse']));

    assertWithinHold(full);
    assertWithinHold(holes);
  },
);

// count files of random data, which no tool can store as holes
function writeRandomFiles(tree: string, count: number, bytes: number) {
  for (let n = 0; n < count; n += 1) {
    writeFileSync(join(tree, `r${String(n)}`), crypto.getRandomValues(new Uint8Array(bytes)));
  }
}

registerSmallFsTest('on a small filesystem, random data takes no more than its hold', async () => {
  const trial = await runDiskTrial(
    SMALL_FS ?? '',
    buildTreeTar((tree) => {
      writeRandomFiles(tree, 3200, 64 * 1024);
    }),
  );

  assertWithinHold(trial);
});

// twice the archive just under a 256 MiB step: 58 000 blocks of random data.
// Held at twice the archive alone, it held 512 MiB and took 536 on XFS.
registerSmallFsTest('on a small filesystem, the rootfs journal is in the hold', async () => {
  const exported = buildTreeTar((tree) => {
    for (let d = 0; d < 58; d += 1) {
      const sub = join(tree, `d${String(d)}`);

      mkdirSync(sub);
      writeRandomFiles(sub, 1000, 4096);
    }
  });

  expect(2 * exported.byteLength).toBeGreaterThan(500 * MIB);
  expect(2 * exported.byteLength).toBeLessThan(512 * MIB);

  const trial = await runDiskTrial(SMALL_FS ?? '', exported);

  assertWithinHold(trial);
});

registerSmallFsTest(
  'on a nearly full small filesystem, a build bigger than the room is refused before the reserve',
  async () => {
    const room = 300 * MIB;

    // one file tar lists in full at once, and files it lists as they come
    const big = buildTreeTar((tree) => {
      Bun.spawnSync(['truncate', '-s', String(500 * MIB), join(tree, 'big')]);
    });

    const many = buildTreeTar((tree) => {
      writeRandomFiles(tree, 400, 1024 * 1024);
    });

    for (const exported of [big, many]) {
      const trial = await runDiskTrial(SMALL_FS ?? '', exported, room);

      expect(trial.outcome).toBe('DISK_FULL');
      expect(trial.peakBytes).toBeLessThanOrEqual(room);
      expect(trial.lowestFree).toBeGreaterThanOrEqual(RESERVE_BYTES);
    }
  },
);
