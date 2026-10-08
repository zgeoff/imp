import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readdirSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@imp/test-utils/update-env';
import { waitFor } from '@imp/test-utils/wait-for';
import type { KyselyPlugin } from 'kysely';
import type { AgentExecRequest, ExecStream } from '../agent-client/exec-stream';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import type { ImpdDeps } from '../create-impd';
import { createImage, findImageByName, listImages } from '../db/images';
import { listImps } from '../db/imps';
import { openDatabase } from '../db/open-database';
import { runChecked } from '../process/run-command';
import {
  buildImagePaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '../storage/data-layout';
import type { StorageBackend } from '../storage/storage-backend';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildFilesTar } from '../test-utils/build-files-tar';
import { buildQueryGate } from '../test-utils/build-query-gate';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubDockerCli } from '../test-utils/build-stub-docker-cli';
import type { StubAnswer } from '../test-utils/build-stub-guest';
import { buildStubImageBuilder } from '../test-utils/build-stub-image-builder';
import { buildStubImageMkfs } from '../test-utils/build-stub-image-mkfs';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { createBuilderImage } from '../test-utils/create-builder-image';
import { findFreePorts } from '../test-utils/find-free-ports';
import { BUILDER_IMAGE, createBuilders } from './builder-imps';
import { HOST_ADD_WARNING, createImageService } from './image-service';

async function setupTest(
  config: {
    // IMP_* settings impd and the image service read
    readonly env?: Readonly<Record<string, string>>;

    // how long the builder image's pull may take
    readonly builderImagePullMs?: number;
  } = {},
) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'isolated-add-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // a host docker that logs every call and models none: an isolated add
  // makes no call; a test that needs the host engine writes its own
  const docker = buildStubDockerCli({ dir: dataDir });

  updateEnv('PATH', docker.path);

  // the builder image pulls' limits, which expirePullLimits ends
  const pullLimits: AbortController[] = [];

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address; a builder takes 512 MiB and 4 GiB
  const impdConfig = loadConfig({
    IMP_DATA_DIR: dataDir,
    IMP_JAILER: 'false',
    IMP_BOOT_TEMPLATES: 'false',
    IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
    ...config.env,
  });

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  // a sparse copy: a builder's disk is a clone of its image's sparse rootfs
  const storage = createXfsBackend({
    dataDir,
    cloneFile: async (source, target) => {
      await runChecked(['cp', '--sparse=always', source, target]);
    },
  });

  const logs: string[] = [];

  const deps: ImpdDeps = {
    db,

    // the bearer impd's API takes; no test here calls it
    rootToken: 'root-token',
    storage,

    // what system.info reports; the drive's hash names the drive file above
    systemFiles: {
      kernelPath: join(dataDir, 'system', 'vmlinux'),
      systemDrivePath,
      info: {
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: drive },
      },
    },

    // the host's free space, so an add never meets this machine's disk
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: (message) => {
      logs.push(message);
    },

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

  const impd = await createImpd(impdConfig, deps);

  stack.defer(() => impd.broker.stop());

  stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  // The image service under test, on the builder imps impd runs, whose
  // agent is the test's; a gate's plugin may hold a select, and a storage
  // may stand in for impd's
  const createImages = (
    open: (request: AgentExecRequest) => Promise<ExecStream>,
    wiring: {
      readonly plugin?: Readonly<KyselyPlugin>;
      readonly storage?: StorageBackend;
    } = {},
  ) => {
    const images = createImageService({
      config: impdConfig,
      db: db.withPlugin(wiring.plugin ?? buildQueryGate('').plugin),
      storage: wiring.storage ?? storage,
      storageGate: impd.storageGate,
      diskBudget: impd.diskBudget,
      readBuilders: () => builders,
      log: (message) => {
        logs.push(message);
      },
      builderImagePullMs: config.builderImagePullMs,

      // a limit that ends only when the test expires it
      startPullLimit: () => {
        const limit = new AbortController();

        pullLimits.push(limit);

        return limit.signal;
      },
    });

    const builders = createBuilders({
      config: impdConfig,
      db,
      imps: { ...impd.imps, openBuilderExec: (_name, request) => open(request) },
      ensureImage: (signal) => images.ensureBuilderImage(signal),
      log: (message) => {
        logs.push(message);
      },
    });

    return { images };
  };

  return {
    // a release deferred here runs before impd stops and its database closes
    stack,
    config: impdConfig,

    // ends every builder image pull limit started so far, as its timeout would
    expirePullLimits: () => {
      for (const limit of pullLimits) {
        limit.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      }
    },
    db,
    dataDir,
    storage,
    diskBudget: impd.diskBudget,
    docker,
    logs,
    createImages,
  };
}

test('it adds an image through a builder for one platform, with no host engine call', async () => {
  const ctx = await setupTest();

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const add = ctx.createImages(builder.guest.open);
  const resolved: string[] = [];

  const image = await add.images.addImage('busybox', 'box', {
    onResolved: (reference) => {
      resolved.push(reference);
    },
  });

  const imps = await listImps(ctx.db);

  const workDirs = readdirSync(join(ctx.dataDir, 'images')).filter((entry) =>
    entry.startsWith('.build-'),
  );

  // keyed as a build is, by impd's own hash of what the builder sent
  expect(image as unknown).toStrictEqual({
    id: expect.any(String) as unknown,
    name: 'box',
    ref: 'busybox',
    digest: expect.stringMatching(/^imp-build-[a-f0-9]{64}$/v) as unknown,
    source: 'oci',
    sourceImp: null,
    sizeBytes: expect.any(Number) as unknown,
    createdAt: expect.any(Date) as unknown,
  });

  // the reference the pull resolved, for the audit row
  expect(resolved).toStrictEqual([`busybox@sha256:${'b'.repeat(64)}`]);
  expect(existsSync(buildImagePaths(ctx.dataDir, image.digest).rootfs)).toBeTrue();
  expect(ctx.docker.readCalls()).toStrictEqual([]);
  expect(workDirs).toStrictEqual([]);
  expect(imps).toStrictEqual([]);

  // the tag written out and the platform named
  expect(builder.guest.runs.map((run) => run.argv.slice(1).join(' '))).toIncludeAllMembers([
    'pull --quiet --platform linux/amd64 busybox:latest',
    'tag busybox:latest imp-build:latest',
  ]);

  // the line goes on with the step timings
  expect(ctx.logs).toSatisfyAny((line: string) =>
    line.startsWith(
      `impd: image add box: busybox:latest for linux/amd64 (busybox@sha256:${'b'.repeat(64)}), digest ${image.digest};`,
    ),
  );
});

test('it returns a failed pull in the builder as the client error', async () => {
  const ctx = await setupTest();

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onPull: () => ({ code: 1, stderr: 'Error response from daemon: manifest unknown' }),
  });

  const add = ctx.createImages(builder.guest.open);

  expect(add.images.addImage('busybox:nope', 'box')).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message:
      'the pull of busybox:nope in the builder failed: Error response from daemon: manifest unknown',
  });
});

test("it returns a registry's refusal of a pull in the builder as the client error", async () => {
  const ctx = await setupTest();

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onPull: () => ({
      code: 1,
      stderr:
        'Error response from daemon: pull access denied for private.test/x, repository does not exist or may require docker login: denied: requested access to the resource is denied',
    }),
  });

  const add = ctx.createImages(builder.guest.open);

  expect(add.images.addImage('private.test/x:1', 'box')).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.stringContaining('requested access to the resource is denied') as unknown,
  });
});

test('it leaves no builder, row or work directory after a failed pull', async () => {
  const ctx = await setupTest();

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onPull: () => ({ code: 1, stderr: 'Error response from daemon: manifest unknown' }),
  });

  const adding = ctx.createImages(builder.guest.open).images.addImage('busybox:nope', 'box');

  await adding.catch(() => {});

  expect(adding).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message:
      'the pull of busybox:nope in the builder failed: Error response from daemon: manifest unknown',
  });

  const imps = await listImps(ctx.db);
  const box = await findImageByName(ctx.db, 'box');

  const workDirs = readdirSync(join(ctx.dataDir, 'images')).filter((entry) =>
    entry.startsWith('.build-'),
  );

  expect(imps).toStrictEqual([]);
  expect(box).toBe(undefined);
  expect(workDirs).toStrictEqual([]);
  expect(ctx.docker.readCalls()).toStrictEqual([]);
});

test('it refuses an export over IMP_BUILD_IMAGE_MAX_MIB', async () => {
  const ctx = await setupTest({ env: { IMP_BUILD_IMAGE_MAX_MIB: '1' } });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dataDir, { big: 'x'.repeat(2 * 1024 ** 2) })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const add = ctx.createImages(builder.guest.open);

  expect(add.images.addImage('busybox:1.37', 'box')).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.stringContaining('IMP_BUILD_IMAGE_MAX_MIB') as unknown,
  });
});

test('it leaves no builder, row or work directory after an export over the limit', async () => {
  const ctx = await setupTest({ env: { IMP_BUILD_IMAGE_MAX_MIB: '1' } });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dataDir, { big: 'x'.repeat(2 * 1024 ** 2) })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const adding = ctx.createImages(builder.guest.open).images.addImage('busybox:1.37', 'box');

  await adding.catch(() => {});

  expect(adding).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.stringContaining('IMP_BUILD_IMAGE_MAX_MIB') as unknown,
  });

  const imps = await listImps(ctx.db);
  const box = await findImageByName(ctx.db, 'box');

  const workDirs = readdirSync(join(ctx.dataDir, 'images')).filter((entry) =>
    entry.startsWith('.build-'),
  );

  expect(imps).toStrictEqual([]);
  expect(box).toBe(undefined);
  expect(workDirs).toStrictEqual([]);
});

test("it changes no host file through an added image's image.json link", async () => {
  const ctx = await setupTest();

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });

  const canary = join(ctx.dataDir, 'canary');
  const tree = join(ctx.dataDir, 'linked-tree');

  await writeFile(canary, "the host's\n");
  await mkdir(join(tree, 'etc', 'imp'), { recursive: true });

  symlinkSync(canary, join(tree, 'etc', 'imp', 'image.json'));

  const builder = buildStubImageBuilder({
    exported: [Bun.spawnSync(['tar', '-C', tree, '-c', '.']).stdout],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  await ctx.createImages(builder.guest.open).images.addImage('busybox:1.37', 'box');

  const content = await readFile(canary, 'utf8');

  expect(content).toBe("the host's\n");
});

test('it ends the pull in the builder, and the builder, when the client goes', async () => {
  const ctx = await setupTest();

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });

  const pulling = Promise.withResolvers<null>();
  const never = Promise.withResolvers<StubAnswer>();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onPull: () => {
      pulling.resolve(null);

      return never.promise;
    },
  });

  const client = new AbortController();

  const adding = ctx
    .createImages(builder.guest.open)
    .images.addImage('busybox:1.37', 'box', { signal: client.signal });

  await pulling.promise;

  client.abort(new Error('the client went'));

  expect(adding).rejects.toThrow('the client went');

  const imps = await listImps(ctx.db);
  const box = await findImageByName(ctx.db, 'box');

  // the exec ends, and the builder's removal ends the pull with it
  expect(builder.guest.runs.find((run) => run.argv[1] === 'pull')?.closed).toBe(true);
  expect(imps).toStrictEqual([]);
  expect(box).toBe(undefined);
});

test.each([
  [
    '203.0.113.5:5000/x:1',
    'image 203.0.113.5:5000/x:1: registry 203.0.113.5:5000 is an IP address',
  ],
  ['localhost:5000/x:1', "image localhost:5000/x:1: registry localhost:5000 is the host's own"],
  ['registry.localhost/x:1', "registry registry.localhost is the host's own"],

  // a bracketed IPv6 literal is no reference the schema takes
  ['[2001:db8::1]:5000/x:1', 'invalid image reference'],
])('it refuses %s before any builder boots', async (ref, problem) => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });
  const add = ctx.createImages(builder.guest.open);

  expect(add.images.addImage(ref, 'box')).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.stringContaining(problem) as unknown,
  });

  const imps = await listImps(ctx.db);

  expect(builder.guest.runs).toStrictEqual([]);
  expect(imps).toStrictEqual([]);
  expect(ctx.docker.readCalls()).toStrictEqual([]);
});

test('it fails the add of a builder the governor refuses, with no host engine call', async () => {
  const ctx = await setupTest({ env: { IMP_RAM_BUDGET_MIB: '256' } });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });
  const add = ctx.createImages(builder.guest.open);

  expect(add.images.addImage('busybox:1.37', 'box')).rejects.toThrow('the whole RAM budget');

  const box = await findImageByName(ctx.db, 'box');

  expect(builder.guest.runs).toStrictEqual([]);
  expect(box).toBe(undefined);
  expect(ctx.docker.readCalls()).toStrictEqual([]);
});

test('it fails the add with SERVICE_UNAVAILABLE when the host engine cannot give the builder image', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });
  const add = ctx.createImages(builder.guest.open);

  expect(add.images.addImage('busybox:1.37', 'box')).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
    message: expect.stringContaining(
      `impd cannot add its builder image ${ctx.config.build.image}`,
    ) as unknown,
  });
});

test('it asks the host engine only for the builder image when it cannot give it', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });
  const adding = ctx.createImages(builder.guest.open).images.addImage('busybox:1.37', 'box');

  await adding.catch(() => {});

  expect(adding).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

  const imps = await listImps(ctx.db);

  // the inspect that found no image, then the pull, both by its digest
  expect(ctx.docker.readCalls()).toStrictEqual([
    `image inspect ${ctx.config.build.image}`,
    `pull --quiet ${ctx.config.build.image}`,
  ]);

  expect(builder.guest.runs).toStrictEqual([]);
  expect(imps).toStrictEqual([]);
});

test('it adds a bumped IMP_BUILD_IMAGE once, by its digest, and moves the row', async () => {
  const ctx = await setupTest();

  // the builder image of an older release
  await createImage(ctx.db, {
    name: BUILDER_IMAGE,
    ref: 'ghcr.io/zgeoff/imp-base:0.1.0',
    digest: `sha256:${'0'.repeat(64)}`,
    sizeBytes: 6,
  });

  // the host engine as the proxy's lock leaves it: the builder image pulls
  // by its digest, and create and export serve a small tree
  buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: [ctx.config.build.image],
        inspects: [{ Id: `sha256:${'f'.repeat(64)}`, Config: {}, Size: 4096 }],
        isOnHost: false,
      },
    ],
    create: { id: 'e'.repeat(64) },
    exportTar: buildFilesTar(ctx.dataDir, { dockerd: 'builder\n' }),
  });

  const add = ctx.createImages(
    buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' }).guest.open,
  );

  // what each add and build calls first; the second finds the row current
  await add.images.ensureBuilderImage();
  await add.images.ensureBuilderImage();

  const row = await findImageByName(ctx.db, BUILDER_IMAGE);

  const pulls = ctx.docker.readCalls().filter((call) => call.startsWith('pull '));

  expect(row?.ref).toStrictEqual(ctx.config.build.image);
  expect(row?.digest).toStrictEqual(`sha256:${'f'.repeat(64)}`);
  expect(pulls).toStrictEqual([`pull --quiet ${ctx.config.build.image}`]);
});

test('it seeds the default image at first start through a builder', async () => {
  const ctx = await setupTest();

  buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: [ctx.config.build.image],
        inspects: [{ Id: `sha256:${'f'.repeat(64)}`, Config: {}, Size: 4096 }],
        isOnHost: false,
      },
    ],
    create: { id: 'e'.repeat(64) },
    exportTar: buildFilesTar(ctx.dataDir, { dockerd: 'builder\n' }),
  });

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  await ctx.createImages(builder.guest.open).images.seedDefaultImage();

  const seeded = await findImageByName(ctx.db, 'ubuntu');

  const image = ctx.config.build.image;

  // the host engine gives only the builder image; ubuntu comes in a builder
  expect(seeded?.ref).toBe('ubuntu:24.04');

  expect(ctx.docker.readCalls()).toStrictEqual([
    `image inspect ${image}`,
    `pull --quiet ${image}`,
    `image inspect ${image}`,
    `create ${image} /bin/true`,
    `export ${'e'.repeat(64)}`,
    `rm -f ${'e'.repeat(64)}`,
  ]);
});

test('it seeds the default image at the next start once the builder image has landed', async () => {
  const ctx = await setupTest();

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  await ctx.createImages(builder.guest.open).images.seedDefaultImage();

  const seeded = await findImageByName(ctx.db, 'ubuntu');

  expect(seeded?.ref).toBe('ubuntu:24.04');
  expect(ctx.docker.readCalls()).toStrictEqual([]);
});

test('it sends an add to the host engine, with a warning and no builder, under IMP_BUILD_ISOLATION=host', async () => {
  const ctx = await setupTest({ env: { IMP_BUILD_ISOLATION: 'host' } });

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  // the host docker models no call, so the add fails there
  const adding = ctx.createImages(builder.guest.open).images.addImage('busybox:1.37', 'box');

  await adding.catch(() => {});

  expect(adding).rejects.toThrow('stub docker: pull --quiet busybox:1.37 is not modelled');

  expect(ctx.docker.readCalls()).toStrictEqual([
    'image inspect busybox:1.37',
    'pull --quiet busybox:1.37',
  ]);

  expect(ctx.logs).toContain(HOST_ADD_WARNING);
  expect(builder.guest.runs).toStrictEqual([]);
});

test('it fails a builder image pull that hangs at its limit, naming IMP_BUILD_IMAGE', async () => {
  const ctx = await setupTest({ builderImagePullMs: 300 });

  buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: [ctx.config.build.image],
        inspects: [{ Id: `sha256:${'f'.repeat(64)}`, Config: {}, Size: 4096 }],
        isOnHost: false,
        pull: 'hang',
      },
    ],
  });

  const add = ctx.createImages(
    buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' }).guest.open,
  );

  const image = ctx.config.build.image;
  const ensuring = add.images.ensureBuilderImage();

  await waitFor(() => {
    expect(ctx.docker.readCalls()).toContain(`pull --quiet ${image}`);
  });

  ctx.expirePullLimits();

  expect(ensuring).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
    message: `impd cannot add its builder image ${image} (IMP_BUILD_IMAGE) from the host engine, so no image add or build can run: the pull did not finish in 0.3 s; on a slow link, pull ${image} on the host engine first (docker pull ${image}), and impd takes it from there`,
  });
});

test('it makes no host engine call beyond the inspect and the pull when the pull hangs', async () => {
  const ctx = await setupTest({ builderImagePullMs: 300 });

  buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: [ctx.config.build.image],
        inspects: [{ Id: `sha256:${'f'.repeat(64)}`, Config: {}, Size: 4096 }],
        isOnHost: false,
        pull: 'hang',
      },
    ],
  });

  const ensuring = ctx
    .createImages(buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' }).guest.open)
    .images.ensureBuilderImage();

  await waitFor(() => {
    expect(ctx.docker.readCalls()).toContain(`pull --quiet ${ctx.config.build.image}`);
  });

  ctx.expirePullLimits();

  await ensuring.catch(() => {});

  expect(ensuring).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

  expect(ctx.docker.readCalls()).toStrictEqual([
    `image inspect ${ctx.config.build.image}`,
    `pull --quiet ${ctx.config.build.image}`,
  ]);
});

test('it pulls the builder image again on the add after a pull that failed', async () => {
  const ctx = await setupTest({ builderImagePullMs: 300 });

  const host = {
    refs: [ctx.config.build.image],
    inspects: [{ Id: `sha256:${'f'.repeat(64)}`, Config: {}, Size: 4096 }],
    isOnHost: false,
  };

  buildStubDockerCli({ dir: ctx.dataDir, images: [{ ...host, pull: 'hang' }] });

  const add = ctx.createImages(
    buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' }).guest.open,
  );

  const failing = add.images.ensureBuilderImage();

  await waitFor(() => {
    expect(ctx.docker.readCalls()).toContain(`pull --quiet ${ctx.config.build.image}`);
  });

  ctx.expirePullLimits();

  await failing.catch(() => {});

  expect(failing).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

  // the registry answers now
  buildStubDockerCli({
    dir: ctx.dataDir,
    images: [{ ...host, pull: 'ok' }],
    create: { id: 'e'.repeat(64) },
    exportTar: buildFilesTar(ctx.dataDir, { dockerd: 'builder\n' }),
  });

  await add.images.ensureBuilderImage();

  const row = await findImageByName(ctx.db, BUILDER_IMAGE);

  const pulls = ctx.docker.readCalls().filter((call) => call.startsWith('pull '));

  expect(row?.ref).toStrictEqual(ctx.config.build.image);
  expect(pulls.length).toBe(2);
});

test('it stops the wait of a caller that goes, and the pull it shared goes on for the others', async () => {
  const ctx = await setupTest();

  buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: [ctx.config.build.image],
        inspects: [{ Id: `sha256:${'f'.repeat(64)}`, Config: {}, Size: 4096 }],
        isOnHost: false,
      },
    ],
    create: { id: 'e'.repeat(64) },
    exportTar: buildFilesTar(ctx.dataDir, { dockerd: 'builder\n' }),
  });

  const add = ctx.createImages(
    buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' }).guest.open,
  );

  const client = new AbortController();

  const leaving = add.images.ensureBuilderImage(client.signal);
  const staying = add.images.ensureBuilderImage();

  client.abort(new Error('the client went'));

  expect(leaving).rejects.toThrow('the client went');

  await staying;

  const row = await findImageByName(ctx.db, BUILDER_IMAGE);

  const pulls = ctx.docker.readCalls().filter((call) => call.startsWith('pull '));

  expect(row?.ref).toStrictEqual(ctx.config.build.image);
  expect(pulls.length).toBe(1);
});

test('it does not pull a builder image the host engine has already', async () => {
  const ctx = await setupTest({ builderImagePullMs: 300 });

  // the operator's own `docker pull` of IMP_BUILD_IMAGE; a pull would hang
  buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: [ctx.config.build.image],
        inspects: [{ Id: `sha256:${'f'.repeat(64)}`, Config: {}, Size: 4096 }],
        pull: 'hang',
      },
    ],
    create: { id: 'e'.repeat(64) },
    exportTar: buildFilesTar(ctx.dataDir, { dockerd: 'builder\n' }),
  });

  await ctx
    .createImages(buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' }).guest.open)
    .images.ensureBuilderImage();

  const row = await findImageByName(ctx.db, BUILDER_IMAGE);

  const pulls = ctx.docker.readCalls().filter((call) => call.startsWith('pull '));

  expect(row?.ref).toStrictEqual(ctx.config.build.image);
  expect(pulls).toStrictEqual([]);
});

test('it names the error of a step after the pull that fails past the limit, not the pull', async () => {
  const ctx = await setupTest({ builderImagePullMs: 300 });

  buildStubDockerCli({
    dir: ctx.dataDir,
    images: [
      {
        refs: [ctx.config.build.image],
        inspects: [{ Id: `sha256:${'f'.repeat(64)}`, Config: {}, Size: 4096 }],
      },
    ],
    create: { id: 'e'.repeat(64) },
    exportTar: buildFilesTar(ctx.dataDir, { dockerd: 'builder\n' }),
  });

  const mkfs = buildStubImageMkfs(ctx.dataDir);

  const ensuring = ctx
    .createImages(buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' }).guest.open)
    .images.ensureBuilderImage();

  await mkfs.waitForStart();

  // the rootfs write outlasts the pull's limit, then fails
  ctx.expirePullLimits();
  mkfs.fail('no space left on device');

  expect(ensuring).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
    message: expect.stringMatching(
      /^(?!.*the pull did not finish).*no space left on device/sv,
    ) as unknown,
  });
});

test('it leaves no row, rootfs, hold or builder when the client leaves an add while mkfs.ext4 runs', async () => {
  const ctx = await setupTest();

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });

  const mkfs = buildStubImageMkfs(ctx.dataDir);

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const client = new AbortController();

  const adding = ctx
    .createImages(builder.guest.open)
    .images.addImage('busybox:1.37', 'box', { signal: client.signal });

  await mkfs.waitForStart();

  client.abort(new Error('the client went'));
  mkfs.release();

  expect(adding).rejects.toThrow('the client went');

  const box = await findImageByName(ctx.db, 'box');
  const status = await ctx.diskBudget.readStatus();
  const imps = await listImps(ctx.db);

  const built = readdirSync(join(ctx.dataDir, 'images')).filter((entry) =>
    entry.startsWith('imp-build-'),
  );

  expect(box).toBe(undefined);
  expect(built).toStrictEqual([]);
  expect(status.pendingBytes).toBe(0);
  expect(imps).toStrictEqual([]);
});

test('it leaves no new row and no rootfs when a template takes the name during an add', async () => {
  const ctx = await setupTest();

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });

  const exporting = Promise.withResolvers<null>();
  const templated = Promise.withResolvers<null>();

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onExport: async () => {
      exporting.resolve(null);

      await templated.promise;
    },
  });

  const adding = ctx.createImages(builder.guest.open).images.addImage('busybox:1.37', 'box');

  await exporting.promise;

  await createImage(ctx.db, {
    name: 'box',
    ref: 'imp:dev',
    digest: `sha256:${'d'.repeat(64)}`,
    sizeBytes: 1,
    source: 'imp',
    sourceImp: 'dev',
  });

  templated.resolve(null);

  expect(adding).rejects.toThrow('image box is a template');

  const box = await findImageByName(ctx.db, 'box');
  const status = await ctx.diskBudget.readStatus();

  const built = readdirSync(join(ctx.dataDir, 'images')).filter((entry) =>
    entry.startsWith('imp-build-'),
  );

  expect(box?.source).toBe('imp');
  expect(built).toStrictEqual([]);
  expect(status.pendingBytes).toBe(0);
});

test("it keeps the other's row and rootfs when an add and a build of one digest run at once and one row fails", async () => {
  const ctx = await setupTest();

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });

  const mkfs = buildStubImageMkfs(ctx.dataDir);

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const service = ctx.createImages(builder.guest.open);
  const adding = service.images.addImage('busybox:1.37', 'box');
  const context = join(ctx.dataDir, 'context');

  await mkdir(context);
  await writeFile(join(context, 'Dockerfile'), 'FROM busybox:1.37\nRUN true\n');

  await Bun.write(
    `${context}.tar`,
    Bun.spawnSync(['tar', '-C', context, '-c', 'Dockerfile']).stdout,
  );

  const building = service.images.buildImageFromContext(`${context}.tar`, 'web', undefined, {
    signal: new AbortController().signal,
  });

  // both exports are in, so both wait on the one mkfs.ext4
  await mkfs.waitForStart();

  await waitFor(() => {
    expect(builder.guest.runs.filter((run) => run.argv[1] === 'export' && run.closed)).toHaveLength(
      2,
    );
  });

  await createImage(ctx.db, {
    name: 'box',
    ref: 'imp:dev',
    digest: `sha256:${'d'.repeat(64)}`,
    sizeBytes: 1,
    source: 'imp',
    sourceImp: 'dev',
  });

  mkfs.release();

  expect(adding).rejects.toThrow('image box is a template');

  const built = await building;
  const status = await ctx.diskBudget.readStatus();

  const rootfs = readdirSync(join(ctx.dataDir, 'images')).filter((entry) =>
    entry.startsWith('imp-build-'),
  );

  expect(built.name).toBe('web');
  expect(rootfs).toStrictEqual([built.digest]);
  expect(status.pendingBytes).toBe(0);
});

test('it keeps the rootfs when an image rm runs while an add of its digest is between rootfs and row', async () => {
  const ctx = await setupTest();

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });

  const gate = buildQueryGate('box');

  // a held select goes before the database closes, however the test ends
  ctx.stack.defer(() => {
    gate.release();
  });

  const exports = { count: 0 };

  // the second add's export arms the gate, after its name check
  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onExport: () => {
      exports.count += 1;

      if (exports.count === 2) {
        gate.arm();
      }

      return Promise.resolve();
    },
  });

  const add = ctx.createImages(builder.guest.open, { plugin: gate.plugin });

  const first = await add.images.addImage('busybox:1.37', 'one');

  const adding = add.images.addImage('busybox:1.37', 'box');

  await gate.reached;

  await add.images.removeImage('one');

  gate.release();

  await adding;

  const rows = await listImages(ctx.db);

  expect(
    rows.filter((row) => row.name !== BUILDER_IMAGE).map((row) => [row.name, row.digest]),
  ).toStrictEqual([['box', first.digest]]);

  expect(existsSync(buildImagePaths(ctx.dataDir, first.digest).rootfs)).toBe(true);
});

test("it removes that rootfs after all when the add's row then fails", async () => {
  const ctx = await setupTest();

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });

  const gate = buildQueryGate('box');

  // a held select goes before the database closes, however the test ends
  ctx.stack.defer(() => {
    gate.release();
  });

  const exports = { count: 0 };

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onExport: () => {
      exports.count += 1;

      if (exports.count === 2) {
        gate.arm();
      }

      return Promise.resolve();
    },
  });

  const add = ctx.createImages(builder.guest.open, { plugin: gate.plugin });

  const first = await add.images.addImage('busybox:1.37', 'one');

  const adding = add.images.addImage('busybox:1.37', 'box');

  await gate.reached;

  await add.images.removeImage('one');

  await createImage(ctx.db, {
    name: 'box',
    ref: 'imp:dev',
    digest: `sha256:${'d'.repeat(64)}`,
    sizeBytes: 1,
    source: 'imp',
    sourceImp: 'dev',
  });

  gate.release();

  expect(adding).rejects.toThrow('UNIQUE');

  const rows = await listImages(ctx.db);

  expect(
    rows.filter((row) => row.name !== BUILDER_IMAGE).map((row) => [row.name, row.digest]),
  ).toStrictEqual([['box', `sha256:${'d'.repeat(64)}`]]);

  expect(existsSync(buildImagePaths(ctx.dataDir, first.digest).rootfs)).toBe(false);
});

test('it logs a cleanup removal that fails, and returns the add its own error', async () => {
  const ctx = await setupTest();

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });

  const exporting = Promise.withResolvers<null>();
  const templated = Promise.withResolvers<null>();

  const builder = buildStubImageBuilder({
    exported: [buildFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onExport: async () => {
      exporting.resolve(null);

      await templated.promise;
    },
  });

  // a storage whose removals fail, as on a disk gone read-only
  const add = ctx.createImages(builder.guest.open, {
    storage: {
      ...ctx.storage,
      removeImage: () => Promise.reject(new Error('the disk is read-only')),
    },
  });

  const adding = add.images.addImage('busybox:1.37', 'box');

  await exporting.promise;

  await createImage(ctx.db, {
    name: 'box',
    ref: 'imp:dev',
    digest: `sha256:${'d'.repeat(64)}`,
    sizeBytes: 1,
    source: 'imp',
    sourceImp: 'dev',
  });

  templated.resolve(null);

  expect(adding).rejects.toThrow('image box is a template');

  expect(ctx.logs).toSatisfyAny((line: string) =>
    /^impd: image box: could not remove the unused rootfs of imp-build-[a-f0-9]{64}: the disk is read-only$/v.test(
      line,
    ),
  );
});
