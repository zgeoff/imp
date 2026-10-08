import { expect, onTestFinished, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { updateEnv } from '@imp/test-utils/update-env';
import { waitFor } from '@imp/test-utils/wait-for';
import type { KyselyPlugin } from 'kysely';
import { loadConfig } from '../config';
import { createImage, findImageByName, listImages } from '../db/images';
import { openDatabase } from '../db/open-database';
import { buildImagePaths } from '../storage/data-layout';
import { createDiskBudget } from '../storage/disk-budget';
import type { StorageBackend } from '../storage/storage-backend';
import { createStorageGate } from '../storage/storage-gate';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildFilesTar } from '../test-utils/build-files-tar';
import { buildQueryGate } from '../test-utils/build-query-gate';
import { buildStubDockerCli } from '../test-utils/build-stub-docker-cli';
import {
  STUB_BUILDER_CONTAINER,
  buildStubImageBuilder,
} from '../test-utils/build-stub-image-builder';
import { buildStubImageMkfs } from '../test-utils/build-stub-image-mkfs';
import { buildTreeTar } from '../test-utils/build-tree-tar';
import { startDiskSampler } from '../test-utils/start-disk-sampler';
import type { Builders } from './builder-imps';
import { createImageService } from './image-service';

async function setupTest(
  config: {
    // IMP_* settings the image service reads
    readonly env?: Readonly<Record<string, string>>;

    // the data dir on this filesystem, whose real free space less
    // reserveBytes is the room, in place of the stub disk's usage
    readonly disk?: { readonly mount: string; readonly reserveBytes: number };
  } = {},
) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const root = await mkdtemp(join(tmpdir(), 'isolated-build-'));

  stack.defer(() => rm(root, { recursive: true, force: true }));

  const dataDir = await mkdtemp(join(config.disk?.mount ?? root, 'data-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // a host docker that logs every call: an isolated build makes none
  const docker = buildStubDockerCli({ dir: root });

  updateEnv('PATH', docker.path);

  const xfs = createXfsBackend({ dataDir });

  // the stub disk's reading; a test that needs a full disk lowers it
  const usage = { usedBytes: 0, availableBytes: 1024 ** 5 };

  const diskBudget = createDiskBudget({
    storage: config.disk === undefined ? { readUsage: () => Promise.resolve(usage) } : xfs,
    reserveBytes: config.disk?.reserveBytes ?? 0,
    log: () => {},
  });

  // each hold a build's growing export asks for
  const grows: number[] = [];

  // the image service on the test's builders; a gate's plugin may hold a
  // select, and a storage may stand in for the data dir's
  const createImages = (
    builders: Builders,
    wiring: {
      readonly plugin?: Readonly<KyselyPlugin>;
      readonly storage?: StorageBackend;
    } = {},
  ) => {
    const images = createImageService({
      config: loadConfig({ ...config.env, IMP_DATA_DIR: dataDir }),
      db: db.withPlugin(wiring.plugin ?? buildQueryGate('').plugin),
      storage: wiring.storage ?? xfs,
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

    // a build of a context holding only this Dockerfile, as an upload is
    const runBuild = async (
      dockerfile: string,
      options: { readonly signal?: AbortSignal; readonly name?: string } = {},
    ) => {
      const context = await mkdtemp(join(root, 'context-'));

      await writeFile(join(context, 'Dockerfile'), dockerfile);

      await Bun.write(
        `${context}.tar`,
        Bun.spawnSync(['tar', '-C', context, '-c', 'Dockerfile']).stdout,
      );

      return images.buildImageFromContext(`${context}.tar`, options.name ?? 'web', undefined, {
        signal: options.signal ?? new AbortController().signal,
      });
    };

    return { images, runBuild };
  };

  return {
    // a release deferred here runs before the database closes
    stack,
    dir: root,
    dataDir,
    db,
    docker,
    storage: xfs,
    usage,
    diskBudget,
    grows,
    createImages,
  };
}

test('it pins, builds and exports in its builder, with no host engine call', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dir, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const build = ctx.createImages(builder.builders);

  const image = await build.runBuild('FROM base.test/a:1\nRUN true\n');
  const saved = await findImageByName(ctx.db, 'web');

  // the digest's own form: no Docker image ID is one
  expect(image as unknown).toStrictEqual({
    id: expect.any(String) as unknown,
    name: 'web',
    ref: 'imp/web:latest',
    digest: expect.stringMatching(/^imp-build-[a-f0-9]{64}$/v) as unknown,
    source: 'oci',
    sourceImp: null,
    sizeBytes: expect.any(Number) as unknown,
    createdAt: expect.any(Date) as unknown,
  });

  expect(saved).toStrictEqual(image);
  expect(existsSync(buildImagePaths(ctx.dataDir, image.digest).rootfs)).toBeTrue();

  expect(builder.builtDockerfiles).toStrictEqual([
    `FROM base.test/a@sha256:${'a'.repeat(64)}\nRUN true\n`,
  ]);

  expect(ctx.docker.readCalls()).toStrictEqual([]);

  expect(builder.guest.runs.map((run) => run.argv.slice(1, 3).join(' '))).toStrictEqual([
    'version --format',
    'image inspect',
    'image inspect',
    'build --progress=plain',
    'image inspect',
    'create imp-build:latest',
    `export ${STUB_BUILDER_CONTAINER}`,
  ]);
});

test('it holds disk in 256 MiB steps as the export grows, not at the image cap', async () => {
  const ctx = await setupTest();

  const build = ctx.createImages(
    buildStubImageBuilder({
      exported: [buildFilesTar(ctx.dir, { hello: 'from the builder\n' })],
      repoDigest: `sha256:${'a'.repeat(64)}`,
    }).builders,
  );

  await build.runBuild('FROM base.test/a:1\nRUN true\n');

  // one 256 MiB step, where the cap would hold 16 GiB
  expect(ctx.grows).toStrictEqual([256 * 1024 ** 2]);
});

test('it refuses with DISK_FULL an export that outgrows the free disk', async () => {
  const ctx = await setupTest();

  // 256 MiB free
  ctx.usage.availableBytes = 256 * 1024 ** 2;

  const big = 'x'.repeat(200 * 1024 ** 2);

  const build = ctx.createImages(
    buildStubImageBuilder({
      exported: [buildFilesTar(ctx.dir, { big })],
      repoDigest: `sha256:${'a'.repeat(64)}`,
    }).builders,
  );

  expect(build.runBuild('FROM base.test/a:1\nRUN true\n')).rejects.toMatchObject({
    code: 'DISK_FULL',
  });
});

test('it stops the export at the step the free disk refuses', async () => {
  const ctx = await setupTest();

  // 256 MiB free
  ctx.usage.availableBytes = 256 * 1024 ** 2;

  const big = 'x'.repeat(200 * 1024 ** 2);

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dir, { big })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const building = ctx.createImages(builder.builders).runBuild('FROM base.test/a:1\nRUN true\n');

  await building.catch(() => {});

  expect(building).rejects.toMatchObject({ code: 'DISK_FULL' });

  // the stub sends its export as one chunk: twice 200 MiB and the rootfs's
  // journal, in 256 MiB steps
  expect(ctx.grows).toStrictEqual([768 * 1024 ** 2]);
  expect(builder.guest.runs.at(-1)?.closed).toBe(true);
});

test('it releases the disk hold once a build succeeds', async () => {
  const ctx = await setupTest();

  const build = ctx.createImages(
    buildStubImageBuilder({
      exported: [buildFilesTar(ctx.dir, { hello: 'from the builder\n' })],
      repoDigest: `sha256:${'a'.repeat(64)}`,
    }).builders,
  );

  await build.runBuild('FROM base.test/a:1\nRUN true\n');

  const status = await ctx.diskBudget.readStatus();

  expect(ctx.grows.length).toBe(1);
  expect(status.pendingBytes).toBe(0);
});

test('it releases the disk hold when the export is over the file limit', async () => {
  const ctx = await setupTest({ env: { IMP_BUILD_IMAGE_MAX_FILES: '5' } });

  const many = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`f${String(n)}`, 'x']));

  const build = ctx.createImages(
    buildStubImageBuilder({
      exported: [buildFilesTar(ctx.dir, many)],
      repoDigest: `sha256:${'a'.repeat(64)}`,
    }).builders,
  );

  const building = build.runBuild('FROM base.test/a:1\nRUN true\n');

  await building.catch(() => {});

  expect(building).rejects.toThrow('is over 5 files');

  const status = await ctx.diskBudget.readStatus();

  expect(ctx.grows.length).toBe(1);
  expect(status.pendingBytes).toBe(0);
});

test('it refuses an export over IMP_BUILD_IMAGE_MAX_FILES', async () => {
  const ctx = await setupTest({ env: { IMP_BUILD_IMAGE_MAX_FILES: '5' } });

  const many = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`f${String(n)}`, 'x']));

  const build = ctx.createImages(
    buildStubImageBuilder({
      exported: [buildFilesTar(ctx.dir, many)],
      repoDigest: `sha256:${'a'.repeat(64)}`,
    }).builders,
  );

  expect(build.runBuild('FROM base.test/a:1\nRUN true\n')).rejects.toThrow('is over 5 files');
});

test('it releases the disk hold when the free disk refuses the export', async () => {
  const ctx = await setupTest();

  // 256 MiB free
  ctx.usage.availableBytes = 256 * 1024 ** 2;

  const big = 'x'.repeat(200 * 1024 ** 2);

  const build = ctx.createImages(
    buildStubImageBuilder({
      exported: [buildFilesTar(ctx.dir, { big })],
      repoDigest: `sha256:${'a'.repeat(64)}`,
    }).builders,
  );

  const building = build.runBuild('FROM base.test/a:1\nRUN true\n');

  await building.catch(() => {});

  expect(building).rejects.toMatchObject({ code: 'DISK_FULL' });

  const status = await ctx.diskBudget.readStatus();

  expect(ctx.grows.length).toBe(1);
  expect(status.pendingBytes).toBe(0);
});

test('it releases the disk hold when the client goes while the builder holds its export open', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dir, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
    isExportStalled: true,
  });

  const client = new AbortController();

  const building = ctx.createImages(builder.builders).runBuild('FROM base.test/a:1\nRUN true\n', {
    signal: client.signal,
  });

  // the export's output is in, and its exit never comes
  await waitFor(() => {
    expect(ctx.grows).not.toBeEmpty();
  });

  client.abort(new Error('the client went'));

  await building.catch(() => {});

  expect(building).rejects.toThrow('the client went');

  const status = await ctx.diskBudget.readStatus();

  expect(status.pendingBytes).toBe(0);
});

test('it fails the build when the client goes while the builder holds its export open', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dir, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
    isExportStalled: true,
  });

  const client = new AbortController();

  const building = ctx.createImages(builder.builders).runBuild('FROM base.test/a:1\nRUN true\n', {
    signal: client.signal,
  });

  await waitFor(() => {
    expect(ctx.grows).not.toBeEmpty();
  });

  client.abort(new Error('the client went'));

  expect(building).rejects.toThrow('the client went');
});

test('it leaves no new row and no rootfs when a template takes the name during the build', async () => {
  const ctx = await setupTest();

  const exporting = Promise.withResolvers<null>();
  const templated = Promise.withResolvers<null>();

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dir, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
    onExport: async () => {
      exporting.resolve(null);

      await templated.promise;
    },
  });

  const building = ctx.createImages(builder.builders).runBuild('FROM base.test/a:1\nRUN true\n');

  await exporting.promise;

  await createImage(ctx.db, {
    name: 'web',
    ref: 'imp:dev',
    digest: `sha256:${'b'.repeat(64)}`,
    sizeBytes: 1,
    source: 'imp',
    sourceImp: 'dev',
  });

  templated.resolve(null);

  await building.catch(() => {});

  expect(building).rejects.toThrow('image web is a template');

  const rows = await listImages(ctx.db);
  const status = await ctx.diskBudget.readStatus();

  expect(rows.map((row) => [row.name, row.source])).toStrictEqual([['web', 'imp']]);

  expect(
    readdirSync(join(ctx.dataDir, 'images')).filter((entry) => entry.startsWith('imp-build-')),
  ).toStrictEqual([]);

  expect(status.pendingBytes).toBe(0);
});

test('it refuses a build whose name a template took during the build', async () => {
  const ctx = await setupTest();

  const exporting = Promise.withResolvers<null>();
  const templated = Promise.withResolvers<null>();

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dir, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
    onExport: async () => {
      exporting.resolve(null);

      await templated.promise;
    },
  });

  const building = ctx.createImages(builder.builders).runBuild('FROM base.test/a:1\nRUN true\n');

  await exporting.promise;

  await createImage(ctx.db, {
    name: 'web',
    ref: 'imp:dev',
    digest: `sha256:${'b'.repeat(64)}`,
    sizeBytes: 1,
    source: 'imp',
    sourceImp: 'dev',
  });

  templated.resolve(null);

  expect(building).rejects.toThrow('image web is a template');
});

test('it keeps the rootfs another build of the digest is writing when its own row fails', async () => {
  const ctx = await setupTest();

  const mkfs = buildStubImageMkfs(ctx.dir);

  updateEnv('PATH', `${mkfs.bin}:${process.env['PATH'] ?? ''}`);

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dir, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const build = ctx.createImages(builder.builders);
  const dockerfile = 'FROM base.test/a:1\nRUN true\n';
  const failing = build.runBuild(dockerfile);
  const kept = build.runBuild(dockerfile, { name: 'web2' });

  // both exports are in, so both builds wait on the one mkfs.ext4
  await mkfs.waitForStart();

  await waitFor(() => {
    expect(builder.guest.runs.filter((run) => run.argv[1] === 'export' && run.closed)).toHaveLength(
      2,
    );
  });

  await createImage(ctx.db, {
    name: 'web',
    ref: 'imp:dev',
    digest: `sha256:${'b'.repeat(64)}`,
    sizeBytes: 1,
    source: 'imp',
    sourceImp: 'dev',
  });

  mkfs.release();

  expect(failing).rejects.toThrow('image web is a template');

  const image = await kept;

  expect(existsSync(buildImagePaths(ctx.dataDir, image.digest).rootfs)).toBeTrue();
});

test('it keeps the rootfs when an image rm runs while a build of its digest is between rootfs and row', async () => {
  const ctx = await setupTest();

  const gate = buildQueryGate('web2');

  // a held select goes before the database closes, however the test ends
  ctx.stack.defer(() => {
    gate.release();
  });

  const exports = { count: 0 };

  // the second build's export arms the gate, after its name check
  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dir, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
    onExport: () => {
      exports.count += 1;

      if (exports.count === 2) {
        gate.arm();
      }

      return Promise.resolve();
    },
  });

  const build = ctx.createImages(builder.builders, { plugin: gate.plugin });
  const dockerfile = 'FROM base.test/a:1\nRUN true\n';

  const first = await build.runBuild(dockerfile);

  const second = build.runBuild(dockerfile, { name: 'web2' });

  await gate.reached;

  await build.images.removeImage('web');

  gate.release();

  await second;

  const rows = await listImages(ctx.db);

  expect(rows.map((row) => [row.name, row.digest])).toStrictEqual([['web2', first.digest]]);
  expect(existsSync(buildImagePaths(ctx.dataDir, first.digest).rootfs)).toBeTrue();
});

test("it removes that rootfs after all when the build's row then fails", async () => {
  const ctx = await setupTest();

  const gate = buildQueryGate('web2');

  // a held select goes before the database closes, however the test ends
  ctx.stack.defer(() => {
    gate.release();
  });

  const exports = { count: 0 };

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dir, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
    onExport: () => {
      exports.count += 1;

      if (exports.count === 2) {
        gate.arm();
      }

      return Promise.resolve();
    },
  });

  const build = ctx.createImages(builder.builders, { plugin: gate.plugin });
  const dockerfile = 'FROM base.test/a:1\nRUN true\n';

  const first = await build.runBuild(dockerfile);

  const second = build.runBuild(dockerfile, { name: 'web2' });

  await gate.reached;

  await build.images.removeImage('web');

  await createImage(ctx.db, {
    name: 'web2',
    ref: 'imp:dev',
    digest: `sha256:${'b'.repeat(64)}`,
    sizeBytes: 1,
    source: 'imp',
    sourceImp: 'dev',
  });

  gate.release();

  expect(second).rejects.toThrow('UNIQUE');

  const rows = await listImages(ctx.db);

  expect(rows.map((row) => [row.name, row.digest])).toStrictEqual([
    ['web2', `sha256:${'b'.repeat(64)}`],
  ]);

  expect(existsSync(buildImagePaths(ctx.dataDir, first.digest).rootfs)).toBeFalse();
});

test('it removes a rootfs whose write fails after it is published', async () => {
  const ctx = await setupTest();

  // a mount that fails once the rootfs is in place, as a ZFS dataset's can
  const build = ctx.createImages(
    buildStubImageBuilder({
      exported: [buildFilesTar(ctx.dir, { hello: 'from the builder\n' })],
      repoDigest: `sha256:${'a'.repeat(64)}`,
    }).builders,
    {
      storage: {
        ...ctx.storage,
        createImage: async (digest, write) => {
          await ctx.storage.createImage(digest, write);

          throw new Error('the mount failed');
        },
      },
    },
  );

  const building = build.runBuild('FROM base.test/a:1\nRUN true\n');

  await building.catch(() => {});

  expect(building).rejects.toThrow('the mount failed');

  const rows = await listImages(ctx.db);

  expect(rows).toStrictEqual([]);

  expect(
    readdirSync(join(ctx.dataDir, 'images')).filter((entry) => entry.startsWith('imp-build-')),
  ).toStrictEqual([]);
});

test('it returns the error of a rootfs write that fails after it is published', async () => {
  const ctx = await setupTest();

  const build = ctx.createImages(
    buildStubImageBuilder({
      exported: [buildFilesTar(ctx.dir, { hello: 'from the builder\n' })],
      repoDigest: `sha256:${'a'.repeat(64)}`,
    }).builders,
    {
      storage: {
        ...ctx.storage,
        createImage: async (digest, write) => {
          await ctx.storage.createImage(digest, write);

          throw new Error('the mount failed');
        },
      },
    },
  );

  expect(build.runBuild('FROM base.test/a:1\nRUN true\n')).rejects.toThrow('the mount failed');
});

test('it leaves no row, rootfs or hold when the client goes while mkfs.ext4 runs', async () => {
  const ctx = await setupTest();

  const mkfs = buildStubImageMkfs(ctx.dir);

  updateEnv('PATH', `${mkfs.bin}:${process.env['PATH'] ?? ''}`);

  const client = new AbortController();

  const building = ctx
    .createImages(
      buildStubImageBuilder({
        exported: [buildFilesTar(ctx.dir, { hello: 'from the builder\n' })],
        repoDigest: `sha256:${'a'.repeat(64)}`,
      }).builders,
    )
    .runBuild('FROM base.test/a:1\nRUN true\n', { signal: client.signal });

  await mkfs.waitForStart();

  client.abort(new Error('the client went'));
  mkfs.release();

  expect(building).rejects.toThrow('the client went');

  const rows = await listImages(ctx.db);
  const status = await ctx.diskBudget.readStatus();

  expect(rows).toStrictEqual([]);

  expect(
    readdirSync(join(ctx.dataDir, 'images')).filter((entry) => entry.startsWith('imp-build-')),
  ).toStrictEqual([]);

  expect(status.pendingBytes).toBe(0);
});

test('it ends a stalled export over a limit at once, with its builder and its disk hold', async () => {
  const ctx = await setupTest({ env: { IMP_BUILD_IMAGE_MAX_FILES: '5' } });

  const many = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`f${String(n)}`, 'x']));

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dir, many)],
    repoDigest: `sha256:${'a'.repeat(64)}`,
    isExportStalled: true,
  });

  const building = ctx.createImages(builder.builders).runBuild('FROM base.test/a:1\nRUN true\n');

  await building.catch(() => {});

  expect(building).rejects.toThrow('is over 5 files');

  const status = await ctx.diskBudget.readStatus();

  expect(builder.readLive()).toBe(0);
  expect(builder.guest.runs.at(-1)?.closed).toBe(true);
  expect(status.pendingBytes).toBe(0);
});

test('it refuses a Dockerfile the input guard refuses', async () => {
  const ctx = await setupTest();

  const build = ctx.createImages(
    buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'a'.repeat(64)}` }).builders,
  );

  expect(
    build.runBuild('FROM base.test/a:1\nADD https://example.com/x /x\n'),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it boots no builder for a Dockerfile the input guard refuses', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'a'.repeat(64)}` });

  const building = ctx
    .createImages(builder.builders)
    .runBuild('FROM base.test/a:1\nADD https://example.com/x /x\n');

  await building.catch(() => {});

  expect(building).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(builder.readBoots()).toBe(0);
  expect(builder.guest.runs).toStrictEqual([]);
});

test("it changes no host file through a built image's image.json link", async () => {
  const ctx = await setupTest();

  const hostFile = join(ctx.dir, 'host-file');
  const tree = join(ctx.dir, 'linked-tree');

  await writeFile(hostFile, "the host's\n");
  await mkdir(join(tree, 'etc', 'imp'), { recursive: true });

  symlinkSync(hostFile, join(tree, 'etc', 'imp', 'image.json'));

  const build = ctx.createImages(
    buildStubImageBuilder({
      exported: [Bun.spawnSync(['tar', '-C', tree, '-c', '.']).stdout],
      repoDigest: `sha256:${'a'.repeat(64)}`,
    }).builders,
  );

  await build.runBuild('FROM base.test/a:1\nRUN true\n');

  expect(readFileSync(hostFile, 'utf8')).toBe("the host's\n");
});

test('it refuses an image whose /etc/imp is a link to a host directory', async () => {
  const ctx = await setupTest();

  const hostDir = join(ctx.dir, 'host-dir');
  const tree = join(ctx.dir, 'linked-tree');

  await mkdir(hostDir);
  await mkdir(join(tree, 'etc'), { recursive: true });

  symlinkSync(hostDir, join(tree, 'etc', 'imp'));

  const build = ctx.createImages(
    buildStubImageBuilder({
      exported: [Bun.spawnSync(['tar', '-C', tree, '-c', '.']).stdout],
      repoDigest: `sha256:${'a'.repeat(64)}`,
    }).builders,
  );

  expect(build.runBuild('FROM base.test/a:1\nRUN true\n')).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.stringContaining("the image's /etc/imp is a symlink") as unknown,
  });
});

test('it writes nothing into the host directory an /etc/imp link names', async () => {
  const ctx = await setupTest();

  const hostDir = join(ctx.dir, 'host-dir');
  const tree = join(ctx.dir, 'linked-tree');

  await mkdir(hostDir);
  await mkdir(join(tree, 'etc'), { recursive: true });

  symlinkSync(hostDir, join(tree, 'etc', 'imp'));

  const build = ctx.createImages(
    buildStubImageBuilder({
      exported: [Bun.spawnSync(['tar', '-C', tree, '-c', '.']).stdout],
      repoDigest: `sha256:${'a'.repeat(64)}`,
    }).builders,
  );

  const building = build.runBuild('FROM base.test/a:1\nRUN true\n');

  await building.catch(() => {});

  expect(building).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.stringContaining("the image's /etc/imp is a symlink") as unknown,
  });

  expect(existsSync(join(hostDir, 'image.json'))).toBeFalse();
});

// A build's disk hold against what it takes on a real filesystem: a small
// one that IMP_TEST_SMALL_FS names (CI mounts a loop XFS for it;
// docs/architecture/storage.md#disk-budget). Without it these skip.
test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it takes no more than its hold for a one-file image on a small filesystem',
  async () => {
    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);

    // the data dir on the small filesystem, 128 MiB of it held back
    const ctx = await setupTest({
      disk: { mount, reserveBytes: 128 * 1024 ** 2 },
    });

    const exported = buildTreeTar(ctx.dir, (tree) => {
      writeFileSync(join(tree, 'hello'), 'from the builder\n');
    });

    // in 1 MiB chunks, as a builder streams its export
    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    // the sampler reads the disk once each rootfs is written, while its tree
    // is still on disk
    const build = ctx.createImages(
      buildStubImageBuilder({ exported: chunks, repoDigest: `sha256:${'a'.repeat(64)}` }).builders,
      {
        storage: {
          ...ctx.storage,
          createImage: async (digest, write) => {
            await ctx.storage.createImage(digest, write);

            sampler.markWritten();
          },
        },
      },
    );

    const trial = await sampler.measure(() => build.runBuild('FROM base.test/a:1\nRUN true\n'));

    const hold = ctx.grows.at(-1);

    invariant(hold);

    expect(trial.outcome).toBe('built');
    expect(trial.settledBytes).toBeLessThanOrEqual(hold);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  // tens of thousands of files run past bun's 5 s default
  120_000,
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it takes no more than its hold for many empty files on a small filesystem',
  async () => {
    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);

    // the data dir on the small filesystem, 128 MiB of it held back
    const ctx = await setupTest({
      disk: { mount, reserveBytes: 128 * 1024 ** 2 },
    });

    const exported = buildTreeTar(ctx.dir, (tree) => {
      for (let d = 0; d < 30; d += 1) {
        mkdirSync(join(tree, `d${String(d)}`));

        for (let n = 0; n < 1000; n += 1) {
          writeFileSync(join(tree, `d${String(d)}`, `f${String(n)}`), '');
        }
      }
    });

    // in 1 MiB chunks, as a builder streams its export
    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    // the sampler reads the disk once each rootfs is written, while its tree
    // is still on disk
    const build = ctx.createImages(
      buildStubImageBuilder({ exported: chunks, repoDigest: `sha256:${'a'.repeat(64)}` }).builders,
      {
        storage: {
          ...ctx.storage,
          createImage: async (digest, write) => {
            await ctx.storage.createImage(digest, write);

            sampler.markWritten();
          },
        },
      },
    );

    const trial = await sampler.measure(() => build.runBuild('FROM base.test/a:1\nRUN true\n'));

    const hold = ctx.grows.at(-1);

    invariant(hold);

    expect(trial.outcome).toBe('built');
    expect(trial.settledBytes).toBeLessThanOrEqual(hold);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  // tens of thousands of files run past bun's 5 s default
  120_000,
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it takes no more than its hold for a deep tree on a small filesystem',
  async () => {
    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);

    // the data dir on the small filesystem, 128 MiB of it held back
    const ctx = await setupTest({
      disk: { mount, reserveBytes: 128 * 1024 ** 2 },
    });

    const exported = buildTreeTar(ctx.dir, (tree) => {
      for (let chain = 0; chain < 300; chain += 1) {
        mkdirSync(join(tree, `c${String(chain)}`, ...Array.from({ length: 40 }, () => 'd')), {
          recursive: true,
        });
      }
    });

    // in 1 MiB chunks, as a builder streams its export
    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    // the sampler reads the disk once each rootfs is written, while its tree
    // is still on disk
    const build = ctx.createImages(
      buildStubImageBuilder({ exported: chunks, repoDigest: `sha256:${'a'.repeat(64)}` }).builders,
      {
        storage: {
          ...ctx.storage,
          createImage: async (digest, write) => {
            await ctx.storage.createImage(digest, write);

            sampler.markWritten();
          },
        },
      },
    );

    const trial = await sampler.measure(() => build.runBuild('FROM base.test/a:1\nRUN true\n'));

    const hold = ctx.grows.at(-1);

    invariant(hold);

    expect(trial.outcome).toBe('built');
    expect(trial.settledBytes).toBeLessThanOrEqual(hold);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  // tens of thousands of files run past bun's 5 s default
  120_000,
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it takes no more than its hold for a sparse file stored in full on a small filesystem',
  async () => {
    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);

    // the data dir on the small filesystem, 128 MiB of it held back
    const ctx = await setupTest({
      disk: { mount, reserveBytes: 128 * 1024 ** 2 },
    });

    // as docker export sends it
    const exported = buildTreeTar(ctx.dir, (tree) => {
      const file = join(tree, 'sparse');

      writeFileSync(file, 'x'.repeat(1024 ** 2));

      Bun.spawnSync(['truncate', '-s', String(400 * 1024 ** 2), file]);
    });

    // in 1 MiB chunks, as a builder streams its export
    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    // the sampler reads the disk once each rootfs is written, while its tree
    // is still on disk
    const build = ctx.createImages(
      buildStubImageBuilder({ exported: chunks, repoDigest: `sha256:${'a'.repeat(64)}` }).builders,
      {
        storage: {
          ...ctx.storage,
          createImage: async (digest, write) => {
            await ctx.storage.createImage(digest, write);

            sampler.markWritten();
          },
        },
      },
    );

    const trial = await sampler.measure(() => build.runBuild('FROM base.test/a:1\nRUN true\n'));

    const hold = ctx.grows.at(-1);

    invariant(hold);

    expect(trial.outcome).toBe('built');
    expect(trial.settledBytes).toBeLessThanOrEqual(hold);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  // tens of thousands of files run past bun's 5 s default
  120_000,
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it takes no more than its hold for a sparse file in a GNU sparse member on a small filesystem',
  async () => {
    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);

    // the data dir on the small filesystem, 128 MiB of it held back
    const ctx = await setupTest({
      disk: { mount, reserveBytes: 128 * 1024 ** 2 },
    });

    const exported = buildTreeTar(
      ctx.dir,
      (tree) => {
        const file = join(tree, 'sparse');

        writeFileSync(file, 'x'.repeat(1024 ** 2));

        Bun.spawnSync(['truncate', '-s', String(400 * 1024 ** 2), file]);
      },
      ['--sparse'],
    );

    // in 1 MiB chunks, as a builder streams its export
    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    // the sampler reads the disk once each rootfs is written, while its tree
    // is still on disk
    const build = ctx.createImages(
      buildStubImageBuilder({ exported: chunks, repoDigest: `sha256:${'a'.repeat(64)}` }).builders,
      {
        storage: {
          ...ctx.storage,
          createImage: async (digest, write) => {
            await ctx.storage.createImage(digest, write);

            sampler.markWritten();
          },
        },
      },
    );

    const trial = await sampler.measure(() => build.runBuild('FROM base.test/a:1\nRUN true\n'));

    const hold = ctx.grows.at(-1);

    invariant(hold);

    expect(trial.outcome).toBe('built');
    expect(trial.settledBytes).toBeLessThanOrEqual(hold);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  // tens of thousands of files run past bun's 5 s default
  120_000,
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it takes no more than its hold for random data on a small filesystem',
  async () => {
    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);

    // the data dir on the small filesystem, 128 MiB of it held back
    const ctx = await setupTest({
      disk: { mount, reserveBytes: 128 * 1024 ** 2 },
    });

    // random data, which no tool can store as holes
    const exported = buildTreeTar(ctx.dir, (tree) => {
      for (let n = 0; n < 3200; n += 1) {
        writeFileSync(
          join(tree, `r${String(n)}`),
          crypto.getRandomValues(new Uint8Array(64 * 1024)),
        );
      }
    });

    // in 1 MiB chunks, as a builder streams its export
    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    // the sampler reads the disk once each rootfs is written, while its tree
    // is still on disk
    const build = ctx.createImages(
      buildStubImageBuilder({ exported: chunks, repoDigest: `sha256:${'a'.repeat(64)}` }).builders,
      {
        storage: {
          ...ctx.storage,
          createImage: async (digest, write) => {
            await ctx.storage.createImage(digest, write);

            sampler.markWritten();
          },
        },
      },
    );

    const trial = await sampler.measure(() => build.runBuild('FROM base.test/a:1\nRUN true\n'));

    const hold = ctx.grows.at(-1);

    invariant(hold);

    expect(trial.outcome).toBe('built');
    expect(trial.settledBytes).toBeLessThanOrEqual(hold);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  // tens of thousands of files run past bun's 5 s default
  120_000,
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it holds the rootfs journal on a small filesystem',
  async () => {
    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);

    // the data dir on the small filesystem, 128 MiB of it held back
    const ctx = await setupTest({
      disk: { mount, reserveBytes: 128 * 1024 ** 2 },
    });

    // twice the archive just under a 256 MiB step: held at twice the archive
    // alone, it held 512 MiB and took 536 on XFS
    const exported = buildTreeTar(ctx.dir, (tree) => {
      for (let d = 0; d < 58; d += 1) {
        mkdirSync(join(tree, `d${String(d)}`));

        for (let n = 0; n < 1000; n += 1) {
          writeFileSync(
            join(tree, `d${String(d)}`, `r${String(n)}`),
            crypto.getRandomValues(new Uint8Array(4096)),
          );
        }
      }
    });

    // in 1 MiB chunks, as a builder streams its export
    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    // the sampler reads the disk once each rootfs is written, while its tree
    // is still on disk
    const build = ctx.createImages(
      buildStubImageBuilder({ exported: chunks, repoDigest: `sha256:${'a'.repeat(64)}` }).builders,
      {
        storage: {
          ...ctx.storage,
          createImage: async (digest, write) => {
            await ctx.storage.createImage(digest, write);

            sampler.markWritten();
          },
        },
      },
    );

    const trial = await sampler.measure(() => build.runBuild('FROM base.test/a:1\nRUN true\n'));

    expect(2 * exported.byteLength).toBeGreaterThan(500 * 1024 ** 2);
    expect(2 * exported.byteLength).toBeLessThan(512 * 1024 ** 2);

    const hold = ctx.grows.at(-1);

    invariant(hold);

    expect(trial.outcome).toBe('built');
    expect(trial.settledBytes).toBeLessThanOrEqual(hold);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  // tens of thousands of files run past bun's 5 s default
  120_000,
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it refuses a file bigger than the room on a nearly full small filesystem before the reserve',
  async () => {
    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);

    // the data dir on the small filesystem, 128 MiB of it held back
    const ctx = await setupTest({
      disk: { mount, reserveBytes: 128 * 1024 ** 2 },
    });

    // one file that tar lists in full at once
    const exported = buildTreeTar(ctx.dir, (tree) => {
      Bun.spawnSync(['truncate', '-s', String(500 * 1024 ** 2), join(tree, 'big')]);
    });

    await sampler.fill(300 * 1024 ** 2, 128 * 1024 ** 2);

    // in 1 MiB chunks, as a builder streams its export
    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    // the sampler reads the disk once each rootfs is written, while its tree
    // is still on disk
    const build = ctx.createImages(
      buildStubImageBuilder({ exported: chunks, repoDigest: `sha256:${'a'.repeat(64)}` }).builders,
      {
        storage: {
          ...ctx.storage,
          createImage: async (digest, write) => {
            await ctx.storage.createImage(digest, write);

            sampler.markWritten();
          },
        },
      },
    );

    const trial = await sampler.measure(() => build.runBuild('FROM base.test/a:1\nRUN true\n'));

    expect(trial.outcome).toBe('DISK_FULL');
    expect(trial.peakBytes).toBeLessThanOrEqual(300 * 1024 ** 2);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  // tens of thousands of files run past bun's 5 s default
  120_000,
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it refuses files bigger than the room on a nearly full small filesystem before the reserve',
  async () => {
    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);

    // the data dir on the small filesystem, 128 MiB of it held back
    const ctx = await setupTest({
      disk: { mount, reserveBytes: 128 * 1024 ** 2 },
    });

    // files that tar lists as they come
    const exported = buildTreeTar(ctx.dir, (tree) => {
      for (let n = 0; n < 400; n += 1) {
        writeFileSync(
          join(tree, `r${String(n)}`),
          crypto.getRandomValues(new Uint8Array(1024 ** 2)),
        );
      }
    });

    await sampler.fill(300 * 1024 ** 2, 128 * 1024 ** 2);

    // in 1 MiB chunks, as a builder streams its export
    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    // the sampler reads the disk once each rootfs is written, while its tree
    // is still on disk
    const build = ctx.createImages(
      buildStubImageBuilder({ exported: chunks, repoDigest: `sha256:${'a'.repeat(64)}` }).builders,
      {
        storage: {
          ...ctx.storage,
          createImage: async (digest, write) => {
            await ctx.storage.createImage(digest, write);

            sampler.markWritten();
          },
        },
      },
    );

    const trial = await sampler.measure(() => build.runBuild('FROM base.test/a:1\nRUN true\n'));

    expect(trial.outcome).toBe('DISK_FULL');
    expect(trial.peakBytes).toBeLessThanOrEqual(300 * 1024 ** 2);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  // tens of thousands of files run past bun's 5 s default
  120_000,
);
