import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@impz/test-utils/invariant';
import { waitFor } from '@impz/test-utils/wait-for';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import type { ImpdDeps } from '../create-impd';
import { createImage } from '../db/images';
import { findImpByName, listImps } from '../db/imps';
import { openDatabase } from '../db/open-database';
import {
  buildImagePaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildMockNewImage } from '../test-utils/build-mock-new-image';
import { buildStubClock } from '../test-utils/build-stub-clock';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubGuest } from '../test-utils/build-stub-guest';
import {
  STUB_BUILDER_CONTAINER,
  buildStubImageBuilder,
} from '../test-utils/build-stub-image-builder';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { createBuilderImage } from '../test-utils/create-builder-image';
import { findFreePorts } from '../test-utils/find-free-ports';
import { createBuilders } from './builder-imps';
import { writeGuestTree } from './guest-build';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'builder-imps-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one
  const config = loadConfig({
    IMP_DATA_DIR: dataDir,
    IMP_JAILER: 'false',
    IMP_BOOT_TEMPLATES: 'false',
    IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
  });

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  const deps: ImpdDeps = {
    db,

    // the bearer impd's API takes; no test here calls the API
    rootToken: 'root-token',
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),

    // what system.info reports; the drive's hash names the drive file above
    systemFiles: {
      kernelPath: join(dataDir, 'system', 'vmlinux'),
      systemDrivePath,
      info: {
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: drive },
      },
    },

    // the host's free space, so a create never meets this machine's disk
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: () => {},

    // Firecracker, the kernel and the CPU as this host reports them
    readIdentity: (files, ipv6Prefix) => ({
      firecrackerVersion: 'v1.17.0',
      snapshotVersion: 'v12.0.0',
      hostKernel: 'test',
      guestKernel: files.info.guestKernel.sha256,
      systemDrive: files.info.systemDrive.sha256,
      systemDrivePath: files.systemDrivePath,
      cpuModel: 'Test CPU',
      cpuFlags: 'test-flags',
      ipv6Prefix,
    }),
    resolveIpv6: () => Promise.resolve(null),
    readTailscale: () =>
      Promise.resolve({ state: null, hostname: null, dnsName: null, ip: null, ips: [] }),
    cgroups: buildStubCpuCgroups().cgroups,
    vms: vmm.startGeneration(),
    taps: { setupTap: () => Promise.resolve(), removeTap: () => Promise.resolve() },
    broker: {
      installBundle: () => Promise.resolve(),
      resolveTunnelTarget: () => Promise.reject(new Error('no network in tests')),
      runOAuthTimer: false,
    },
    egress: {
      runNft: () => Promise.resolve(),
      flushConnections: () => Promise.resolve(),
      flushPair: () => Promise.resolve(),
      readForwardRules: () => Promise.resolve(''),
      forward: () => Promise.reject(new Error('no upstream in tests')),
      resolveExact: () => Promise.resolve([]),
      readConnected4: () => Promise.resolve(['172.17.0.0/16']),
      readConnected6: () => Promise.resolve([]),
      readUplinks: () => Promise.resolve({ ipv4: ['eth0'], ipv6: [] }),
    },
    imps: {
      readRamMib: (pid) => (vmm.alive.has(pid) ? 300 : null),
      readRssMib: (pid) => (vmm.alive.has(pid) ? 340 : null),
      growFilesystem: () => Promise.resolve(false),
      hostCpus: 8,
    },
    freezer: { freeze: () => Promise.resolve(), thaw: () => Promise.resolve() },
  };

  const impd = await createImpd(config, deps);

  stack.defer(() => impd.broker.stop());

  stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  return {
    config,
    db,
    dataDir,
    vmm,
    impd,
  };
}

test('it gives a build a public builder of the build size', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));

  const builders = createBuilders({
    config: { build: { ...ctx.config.build, memoryMib: 512, diskBytes: 4 * 1024 ** 3 } },
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    log: () => {},
  });

  const builder = await builders.withBuilder(new AbortController().signal, async () => {
    const imps = await listImps(ctx.db);

    return imps.find((imp) => imp.kind === 'builder');
  });

  expect(builder).toMatchObject({
    kind: 'builder',
    name: expect.stringMatching(/^imp-build-[a-z2-9]{8}$/v) as unknown,
    memoryMib: 512,
    diskBytes: 4 * 1024 ** 3,
  });
});

test('it holds the public egress policy for the builder while the build runs', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    log: () => {},
  });

  const policy = await builders.withBuilder(new AbortController().signal, async () => {
    const [builder] = await listImps(ctx.db);

    invariant(builder);

    return ctx.impd.egress.readPolicy(builder.name);
  });

  expect(policy).toStrictEqual({ mode: 'public', allow: [] });
});

test('it removes the builder and its egress policy when the build ends', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    log: () => {},
  });

  const name = await builders.withBuilder(new AbortController().signal, async () => {
    const [builder] = await listImps(ctx.db);

    invariant(builder);

    return builder.name;
  });

  const imps = await listImps(ctx.db);

  expect(imps).toStrictEqual([]);

  expect(ctx.impd.egress.readPolicy(name)).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: `imp ${name} not found`,
  });
});

test('it adds the builder image before the builder starts', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));
  const ensured: string[] = [];

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      const builderImage = await createBuilderImage({
        db: ctx.db,
        dataDir: ctx.dataDir,
        ref: ctx.config.build.image,
      });

      ensured.push(builderImage.name);
    },
    log: () => {},
  });

  await builders.withBuilder(new AbortController().signal, () => Promise.resolve());

  expect(ensured).toStrictEqual(['imp-builder']);
});

test('it asks the builder engine again, a poll later, until it answers, then runs the build', async () => {
  const ctx = await setupTest();

  const infos = { count: 0 };

  // the first `docker info` finds the engine still starting
  const guest = buildStubGuest((run) => {
    if (run.argv[1] !== 'info') {
      return { stdout: 'ok' };
    }

    infos.count += 1;

    return infos.count === 1 ? { code: 1, stderr: 'Cannot connect to the Docker daemon' } : {};
  });

  const clock = buildStubClock();

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    log: () => {},
    engineClock: { now: clock.now, wait: clock.sleep },
  });

  const ran = await builders.withBuilder(new AbortController().signal, async (exec) => {
    const answered = await exec(['echo'], { signal: new AbortController().signal });

    return answered.stdout;
  });

  expect(ran).toBe('ok');
  expect(clock.sleeps).toStrictEqual([500]);

  expect(guest.runs.map((run) => run.argv.join(' '))).toStrictEqual([
    'docker info --format {{.ServerVersion}}',
    'docker info --format {{.ServerVersion}}',
    'echo',
  ]);
});

test('it fails the build when the builder engine does not answer in 60 s, and removes the builder', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ code: 1, stderr: 'Cannot connect to the Docker daemon' }));

  // each poll's wait moves the clock on by its 500 ms
  const clock = buildStubClock();

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    log: () => {},
    engineClock: { now: clock.now, wait: clock.sleep },
  });

  const building = builders.withBuilder(new AbortController().signal, () =>
    Promise.resolve('built'),
  );

  expect(building).rejects.toThrowWithMessage(
    Error,
    "the builder's engine did not answer in 60 s: Cannot connect to the Docker daemon",
  );

  const imps = await listImps(ctx.db);

  expect(imps).toStrictEqual([]);
});

test('it removes the builder of a failed build and rethrows the build error', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    log: () => {},
  });

  const building = builders.withBuilder(new AbortController().signal, () =>
    Promise.reject(new Error('the build failed')),
  );

  expect(building).rejects.toThrowWithMessage(Error, 'the build failed');

  const imps = await listImps(ctx.db);

  expect(imps).toStrictEqual([]);
});

test('it removes the builders a stopped impd left, and never a user imp', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: () => Promise.resolve(),
    log: () => {},
  });

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-left', image: 'base', kind: 'builder' });
  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await builders.removeLeftovers();

  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => imp.name)).toStrictEqual(['dev']);
});

test('it keeps the build of a builder that survives its removal, and logs the survivor', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));
  const timers = buildStubClock();
  const logs: string[] = [];

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    log: (message) => {
      logs.push(message);
    },
    startTimer: timers.startTimer,
  });

  // the builder's Firecracker survives SIGKILL, so its removal fails
  ctx.vmm.queue('stop', 'fail');

  const built = await builders.withBuilder(new AbortController().signal, () =>
    Promise.resolve('built'),
  );

  const survivors = await listImps(ctx.db);

  expect(built).toBe('built');
  expect(survivors.map((imp) => imp.kind)).toStrictEqual(['builder']);
  expect(timers.readPendingMs()).toStrictEqual([30_000]);

  expect(logs).toSatisfyAny((line: string) =>
    /^impd: image build: ERROR: builder imp-build-[a-z2-9]{8} survives its removal, tried again every 30 s: firecracker \d+ survived SIGKILL$/v.test(
      line,
    ),
  );
});

test('it removes a builder that survived its removal on a later retry', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));
  const timers = buildStubClock();
  const logs: string[] = [];

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    log: (message) => {
      logs.push(message);
    },
    startTimer: timers.startTimer,
  });

  // the first removal meets a Firecracker that survives SIGKILL; the
  // retry's stop goes through
  ctx.vmm.queue('stop', 'fail');

  await builders.withBuilder(new AbortController().signal, () => Promise.resolve());

  const survivors = await listImps(ctx.db);

  timers.firePending();

  await waitFor(() => {
    expect(logs).toSatisfyAny((line: string) =>
      /^impd: image build: removed builder imp-build-[a-z2-9]{8}$/v.test(line),
    );
  });

  const imps = await listImps(ctx.db);

  expect(survivors.map((imp) => imp.kind)).toStrictEqual(['builder']);
  expect(imps).toStrictEqual([]);
});

test('it retries the removal of a leftover builder that survives it at start', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));
  const timers = buildStubClock();
  const logs: string[] = [];

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: () => Promise.resolve(),
    log: (message) => {
      logs.push(message);
    },
    startTimer: timers.startTimer,
  });

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-left', image: 'base', kind: 'builder' });

  // the removal at start and the first retry meet a Firecracker that
  // survives SIGKILL; the second retry's stop goes through
  ctx.vmm.queue('stop', 'fail', 'fail');

  await builders.removeLeftovers();

  timers.firePending();

  await waitFor(() => {
    expect(timers.readPendingMs()).toStrictEqual([30_000]);
  });

  timers.firePending();

  await waitFor(() => {
    expect(logs).toContain('impd: image build: removed builder imp-build-left');
  });

  const imps = await listImps(ctx.db);

  const errors = logs.filter((line) => line.includes('ERROR: builder imp-build-left'));

  expect(imps).toStrictEqual([]);
  expect(errors).toHaveLength(2);
});

test('it never removes a user imp that took the id of a removed builder on a retry', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));
  const timers = buildStubClock();
  const logs: string[] = [];

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: () => Promise.resolve(),
    log: (message) => {
      logs.push(message);
    },
    startTimer: timers.startTimer,
  });

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  const builder = await ctx.impd.imps.createImp({
    name: 'imp-build-left',
    image: 'base',
    kind: 'builder',
  });

  const record = await findImpByName(ctx.db, builder.name);

  invariant(record);

  const id = record.id;

  // the removal at start meets a Firecracker that survives SIGKILL
  ctx.vmm.queue('stop', 'fail');

  await builders.removeLeftovers();

  // before the retry, the builder goes, and a user imp takes its id
  await ctx.impd.imps.destroyImpId(id);
  await ctx.impd.imps.createImp({ id, name: 'mine', image: 'base' });

  timers.firePending();

  await waitFor(() => {
    expect(logs).toContain('impd: image build: removed builder imp-build-left');
  });

  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => [imp.id, imp.name, imp.kind])).toStrictEqual([[id, 'mine', 'user']]);
});

test('it ends an export over its file limit and removes its builder, with no client cancel', async () => {
  const ctx = await setupTest();
  const tree = await mkdtemp(join(tmpdir(), 'builder-stall-'));

  onTestFinished(() => rm(tree, { recursive: true, force: true }));

  const parents = Array.from({ length: 20 }, (_, n) => `d${String(n)}`).join('/');

  await mkdir(join(tree, 'tree', parents), { recursive: true });
  await writeFile(join(tree, 'tree', parents, 'f'), 'x');
  await mkdir(join(tree, 'root'));

  const deep = Bun.spawnSync([
    'tar',
    '-C',
    join(tree, 'tree'),
    '--no-recursion',
    '-c',
    `${parents}/f`,
  ]);

  // the export sends its tar, then stalls without an exit
  const engine = buildStubImageBuilder({
    exported: [deep.stdout],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    isExportStalled: true,
  });

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => engine.guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    log: () => {},
  });

  const exporting = builders.withBuilder(new AbortController().signal, (exec) =>
    writeGuestTree(
      exec,
      join(tree, 'root'),
      { maxBytes: 1024 ** 3, maxFiles: 1 },
      new AbortController().signal,
    ),
  );

  expect(exporting).rejects.toThrowWithMessage(
    Error,
    "the built image's filesystem is over 1 files (IMP_BUILD_IMAGE_MAX_FILES)",
  );

  const imps = await listImps(ctx.db);

  expect(imps).toStrictEqual([]);
});

test('it ends an export stopped while its exec opens, closes the exec and removes its builder', async () => {
  const ctx = await setupTest();
  const tree = await mkdtemp(join(tmpdir(), 'builder-open-'));

  onTestFinished(() => rm(tree, { recursive: true, force: true }));

  await mkdir(join(tree, 'root'));

  const engine = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    isExportStalled: true,
  });

  const timers = buildStubClock();

  // the export's exec opens only once the test lets it
  const exportOpen = Promise.withResolvers<void>();
  const reached = { isExportOpening: false };

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: async (_name, request) => {
        if (request.argv[1] === 'export') {
          reached.isExportOpening = true;

          await exportOpen.promise;
        }

        return engine.guest.open(request);
      },
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    log: () => {},
  });

  const exporting = builders.withBuilder(new AbortController().signal, (exec) =>
    writeGuestTree(
      exec,
      join(tree, 'root'),
      { maxBytes: 1024 ** 3, maxFiles: 1000 },
      new AbortController().signal,
      () => Promise.resolve(),
      timers.startTimer,
    ),
  );

  await waitFor(() => {
    expect(reached.isExportOpening).toBeTrue();
  });

  // the idle limit falls due while the exec opens
  timers.firePending();
  exportOpen.resolve();

  expect(exporting).rejects.toThrowWithMessage(
    Error,
    'docker export in the builder sent nothing in 120 s',
  );

  const imps = await listImps(ctx.db);

  expect(engine.guest.runs.at(-1)).toMatchObject({
    argv: ['docker', 'export', STUB_BUILDER_CONTAINER],
    closed: true,
  });

  expect(imps).toStrictEqual([]);
});

test('it refuses an exec in a builder', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const opening = ctx.impd.imps.openExec('imp-build-x', { argv: ['sh'], tty: false });

  expect(opening).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('it leaves the imp that holds a name a builder create fails on', async () => {
  const ctx = await setupTest();

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,

      // a user imp takes the builder's name just before its create
      createImp: async (input) => {
        await ctx.impd.imps.createImp({ name: input.name, image: 'base' });

        return ctx.impd.imps.createImp(input);
      },
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    log: () => {},
  });

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  const building = builders.withBuilder(new AbortController().signal, () =>
    Promise.resolve('built'),
  );

  expect(building).rejects.toMatchObject({ code: 'CONFLICT' });

  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => imp.kind)).toStrictEqual(['user']);
  expect(imps[0]?.name).toMatch(/^imp-build-[a-z2-9]{8}$/v);
});
