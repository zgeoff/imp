import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import type { ImpdDeps } from '../create-impd';
import { createImage } from '../db/images';
import { findImpByName, listImps } from '../db/imps';
import { openDatabase } from '../db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubGuest } from '../test-utils/build-stub-guest';
import {
  STUB_BUILDER_CONTAINER,
  buildStubImageBuilder,
} from '../test-utils/build-stub-image-builder';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { BUILDER_IMAGE, createBuilders } from './builder-imps';
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

    // the bearer the test's client sends
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

  // the root bearer's client, against impd's own app
  const client: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: 'Bearer root-token' },
      fetch: (request) => impd.api.app.handle(request),
    }),
  );

  return {
    config,
    db,
    dataDir,
    impd,
    client,
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
      await Bun.write(join(ctx.dataDir, 'images', BUILDER_IMAGE, 'rootfs.ext4'), 'rootfs');

      await createImage(ctx.db, {
        name: BUILDER_IMAGE,
        ref: `${BUILDER_IMAGE}:latest`,
        digest: `sha256:${BUILDER_IMAGE}`,
        sizeBytes: 6,
      });
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
      await Bun.write(join(ctx.dataDir, 'images', BUILDER_IMAGE, 'rootfs.ext4'), 'rootfs');

      await createImage(ctx.db, {
        name: BUILDER_IMAGE,
        ref: `${BUILDER_IMAGE}:latest`,
        digest: `sha256:${BUILDER_IMAGE}`,
        sizeBytes: 6,
      });
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
      await Bun.write(join(ctx.dataDir, 'images', BUILDER_IMAGE, 'rootfs.ext4'), 'rootfs');

      await createImage(ctx.db, {
        name: BUILDER_IMAGE,
        ref: `${BUILDER_IMAGE}:latest`,
        digest: `sha256:${BUILDER_IMAGE}`,
        sizeBytes: 6,
      });
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
      ensured.push(BUILDER_IMAGE);

      await Bun.write(join(ctx.dataDir, 'images', BUILDER_IMAGE, 'rootfs.ext4'), 'rootfs');

      await createImage(ctx.db, {
        name: BUILDER_IMAGE,
        ref: `${BUILDER_IMAGE}:latest`,
        digest: `sha256:${BUILDER_IMAGE}`,
        sizeBytes: 6,
      });
    },
    log: () => {},
  });

  await builders.withBuilder(new AbortController().signal, () => Promise.resolve());

  expect(ensured).toStrictEqual([BUILDER_IMAGE]);
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

  const waits: number[] = [];

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await Bun.write(join(ctx.dataDir, 'images', BUILDER_IMAGE, 'rootfs.ext4'), 'rootfs');

      await createImage(ctx.db, {
        name: BUILDER_IMAGE,
        ref: `${BUILDER_IMAGE}:latest`,
        digest: `sha256:${BUILDER_IMAGE}`,
        sizeBytes: 6,
      });
    },
    log: () => {},
    engineClock: {
      now: () => 0,
      wait: (ms) => {
        waits.push(ms);

        return Promise.resolve();
      },
    },
  });

  const ran = await builders.withBuilder(new AbortController().signal, async (exec) => {
    const answered = await exec(['echo'], { signal: new AbortController().signal });

    return answered.stdout;
  });

  expect(ran).toBe('ok');
  expect(waits).toStrictEqual([500]);

  expect(guest.runs.map((run) => run.argv.join(' '))).toStrictEqual([
    'docker info --format {{.ServerVersion}}',
    'docker info --format {{.ServerVersion}}',
    'echo',
  ]);
});

test('it fails the build when the builder engine does not answer in 60 s, and removes the builder', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ code: 1, stderr: 'Cannot connect to the Docker daemon' }));

  // each poll's wait moves the clock on by 20 s
  const clock = { nowMs: 0 };

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await Bun.write(join(ctx.dataDir, 'images', BUILDER_IMAGE, 'rootfs.ext4'), 'rootfs');

      await createImage(ctx.db, {
        name: BUILDER_IMAGE,
        ref: `${BUILDER_IMAGE}:latest`,
        digest: `sha256:${BUILDER_IMAGE}`,
        sizeBytes: 6,
      });
    },
    log: () => {},
    engineClock: {
      now: () => clock.nowMs,
      wait: () => {
        clock.nowMs += 20_000;

        return Promise.resolve();
      },
    },
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
      await Bun.write(join(ctx.dataDir, 'images', BUILDER_IMAGE, 'rootfs.ext4'), 'rootfs');

      await createImage(ctx.db, {
        name: BUILDER_IMAGE,
        ref: `${BUILDER_IMAGE}:latest`,
        digest: `sha256:${BUILDER_IMAGE}`,
        sizeBytes: 6,
      });
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

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'imp-build-left', image: 'base', kind: 'builder' });
  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await builders.removeLeftovers();

  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => imp.name)).toStrictEqual(['dev']);
});

test('it keeps the build of a builder that survives its removal, and logs the survivor', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));
  const logs: string[] = [];

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),

      // the jailer never stops: every removal fails
      destroyImpId: () => Promise.reject(new Error('the jailer did not stop')),
    },
    ensureImage: async () => {
      await Bun.write(join(ctx.dataDir, 'images', BUILDER_IMAGE, 'rootfs.ext4'), 'rootfs');

      await createImage(ctx.db, {
        name: BUILDER_IMAGE,
        ref: `${BUILDER_IMAGE}:latest`,
        digest: `sha256:${BUILDER_IMAGE}`,
        sizeBytes: 6,
      });
    },
    log: (message) => {
      logs.push(message);
    },
    removeRetryMs: 60_000,
  });

  const built = await builders.withBuilder(new AbortController().signal, () =>
    Promise.resolve('built'),
  );

  const survivors = await listImps(ctx.db);

  expect(built).toBe('built');
  expect(survivors.map((imp) => imp.kind)).toStrictEqual(['builder']);

  expect(logs).toSatisfyAny((line: string) =>
    /^impd: image build: ERROR: builder imp-build-[a-z2-9]{8} survives/v.test(line),
  );
});

test('it removes a builder that survived its removal on a later retry', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));
  const logs: string[] = [];
  const destroys = { failed: 0 };

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),

      // the first removal fails; the retry goes through
      destroyImpId: async (id, kind) => {
        if (destroys.failed === 0) {
          destroys.failed += 1;
          throw new Error('the jailer did not stop');
        }

        await ctx.impd.imps.destroyImpId(id, kind);
      },
    },
    ensureImage: async () => {
      await Bun.write(join(ctx.dataDir, 'images', BUILDER_IMAGE, 'rootfs.ext4'), 'rootfs');

      await createImage(ctx.db, {
        name: BUILDER_IMAGE,
        ref: `${BUILDER_IMAGE}:latest`,
        digest: `sha256:${BUILDER_IMAGE}`,
        sizeBytes: 6,
      });
    },
    log: (message) => {
      logs.push(message);
    },
    removeRetryMs: 10,
  });

  await builders.withBuilder(new AbortController().signal, () => Promise.resolve());

  const removed = await waitFor(() => {
    const line = logs.find((each) => each.startsWith('impd: image build: removed builder'));

    if (line === undefined) {
      throw new Error('no retry removed the builder yet');
    }

    return line;
  });

  const imps = await listImps(ctx.db);

  expect(removed).toMatch(/^impd: image build: removed builder imp-build-[a-z2-9]{8}$/v);
  expect(imps).toStrictEqual([]);
});

test('it retries the removal of a leftover builder that survives it at start', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));
  const logs: string[] = [];
  const destroys = { failed: 0 };

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),

      // the first two removals fail; the next goes through
      destroyImpId: async (id, kind) => {
        if (destroys.failed < 2) {
          destroys.failed += 1;
          throw new Error('the jailer did not stop');
        }

        await ctx.impd.imps.destroyImpId(id, kind);
      },
    },
    ensureImage: () => Promise.resolve(),
    log: (message) => {
      logs.push(message);
    },
    removeRetryMs: 10,
  });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'imp-build-left', image: 'base', kind: 'builder' });
  await builders.removeLeftovers();

  await waitFor(() => {
    if (!logs.includes('impd: image build: removed builder imp-build-left')) {
      throw new Error('no retry removed the builder yet');
    }
  });

  const imps = await listImps(ctx.db);

  const errors = logs.filter((line) => line.includes('ERROR: builder imp-build-left'));

  expect(imps).toStrictEqual([]);
  expect(errors).toHaveLength(2);
});

test('it never removes a user imp that took the id of a removed builder on a retry', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));
  const logs: string[] = [];
  const released = Promise.withResolvers<void>();
  const destroys = { failed: 0 };

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),

      // the first removal fails; the retries wait for the test
      destroyImpId: async (id, kind) => {
        if (destroys.failed === 0) {
          destroys.failed += 1;
          throw new Error('the jailer did not stop');
        }

        await released.promise;

        await ctx.impd.imps.destroyImpId(id, kind);
      },
    },
    ensureImage: () => Promise.resolve(),
    log: (message) => {
      logs.push(message);
    },
    removeRetryMs: 10,
  });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const builder = await ctx.impd.imps.createImp({
    name: 'imp-build-left',
    image: 'base',
    kind: 'builder',
  });

  const record = await findImpByName(ctx.db, builder.name);

  invariant(record);

  const id = record.id;

  await builders.removeLeftovers();
  await ctx.impd.imps.destroyImpId(id);
  await ctx.impd.imps.createImp({ id, name: 'mine', image: 'base' });

  released.resolve();

  await waitFor(() => {
    if (!logs.includes('impd: image build: removed builder imp-build-left')) {
      throw new Error('no retry ran yet');
    }
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
      await Bun.write(join(ctx.dataDir, 'images', BUILDER_IMAGE, 'rootfs.ext4'), 'rootfs');

      await createImage(ctx.db, {
        name: BUILDER_IMAGE,
        ref: `${BUILDER_IMAGE}:latest`,
        digest: `sha256:${BUILDER_IMAGE}`,
        sizeBytes: 6,
      });
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

  expect(exporting).rejects.toThrow('is over 1 files');

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

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,

      // the export's exec opens only after its idle stop, a timer due before
      // this one: timers fire in the order they fall due
      openBuilderExec: async (_name, request) => {
        if (request.argv[1] === 'export') {
          const opened = Promise.withResolvers<void>();

          setTimeout(opened.resolve, 20);

          await opened.promise;
        }

        return engine.guest.open(request);
      },
    },
    ensureImage: async () => {
      await Bun.write(join(ctx.dataDir, 'images', BUILDER_IMAGE, 'rootfs.ext4'), 'rootfs');

      await createImage(ctx.db, {
        name: BUILDER_IMAGE,
        ref: `${BUILDER_IMAGE}:latest`,
        digest: `sha256:${BUILDER_IMAGE}`,
        sizeBytes: 6,
      });
    },
    log: () => {},
  });

  const exporting = builders.withBuilder(new AbortController().signal, (exec) =>
    writeGuestTree(
      exec,
      join(tree, 'root'),
      { maxBytes: 1024 ** 3, maxFiles: 1000, idleMs: 1 },
      new AbortController().signal,
    ),
  );

  expect(exporting).rejects.toThrow('docker export in the builder sent nothing in 0.001 s');

  const imps = await listImps(ctx.db);

  expect(engine.guest.runs.at(-1)).toMatchObject({
    argv: ['docker', 'export', STUB_BUILDER_CONTAINER],
    closed: true,
  });

  expect(imps).toStrictEqual([]);
});

test('it refuses an exec in a builder', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const opening = ctx.impd.imps.openExec('imp-build-x', { argv: ['sh'], tty: false });

  expect(opening).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.stringContaining('imp-build-x is an image builder') as unknown,
  });
});

test('it refuses a policy change of a builder', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const setting = ctx.client.imps.setPolicy({
    name: 'imp-build-x',
    policy: { mode: 'open', allow: [] },
  });

  expect(setting).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.stringContaining('imp-build-x is an image builder') as unknown,
  });
});

test('it refuses an exec ticket for a builder', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const ticketing = ctx.client.exec.ticket({ name: 'imp-build-x' });

  expect(ticketing).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.stringContaining('imp-build-x is an image builder') as unknown,
  });
});

test('it refuses a fork of a builder', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const forking = ctx.client.imps.fork({ source: 'imp-build-x', name: 'copy' });

  expect(forking).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.stringContaining('imp-build-x is an image builder') as unknown,
  });
});

test('it refuses a stop of a builder', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const stopping = ctx.client.imps.stop({ name: 'imp-build-x' });

  expect(stopping).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.stringContaining('imp-build-x is an image builder') as unknown,
  });
});

test('it refuses a checkpoint of a builder', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const checkpointing = ctx.client.checkpoints.create({ name: 'imp-build-x' });

  expect(checkpointing).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.stringContaining('imp-build-x is an image builder') as unknown,
  });
});

test('it refuses a template of a builder', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const adding = ctx.client.images.add({ imp: 'imp-build-x', name: 'tpl' });

  expect(adding).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.stringContaining('imp-build-x is an image builder') as unknown,
  });
});

test('it refuses a move of a builder', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const preparing = ctx.client.moves.prepare({ name: 'imp-build-x' });

  expect(preparing).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.stringContaining('imp-build-x is an image builder') as unknown,
  });
});

test('it lists a builder only when the caller asks for builders', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });
  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const listed = await ctx.client.imps.list();
  const all = await ctx.client.imps.list({ builders: true });

  expect(listed.map((imp) => imp.name)).toStrictEqual(['dev']);

  expect(all.map((imp) => [imp.name, imp.kind])).toStrictEqual([
    ['dev', 'user'],
    ['imp-build-x', 'builder'],
  ]);
});

test('it shows a builder by its name as a builder', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const info = await ctx.client.imps.get({ name: 'imp-build-x' });

  expect(info.kind).toBe('builder');
});

test('it lets a client remove a builder', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });
  await ctx.client.imps.destroy({ name: 'imp-build-x' });

  const gone = await findImpByName(ctx.db, 'imp-build-x');

  expect(gone).toBeUndefined();
});

test('it refuses an add from a registry named imp-builder, which is impd’s', async () => {
  const ctx = await setupTest();

  const adding = ctx.client.images.add({ ref: 'busybox:latest', name: BUILDER_IMAGE });

  expect(adding).rejects.toThrow(`the image name ${BUILDER_IMAGE} is impd's`);
});

test('it refuses a template named imp-builder, which is impd’s', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const adding = ctx.client.images.add({ imp: 'dev', name: BUILDER_IMAGE });

  expect(adding).rejects.toThrow(`the image name ${BUILDER_IMAGE} is impd's`);
});

test('it refuses a build named imp-builder, which is impd’s', async () => {
  const ctx = await setupTest();

  const building = ctx.impd.images.buildImageFromContext('/nowhere.tar', BUILDER_IMAGE, undefined, {
    signal: new AbortController().signal,
  });

  expect(building).rejects.toThrow(`the image name ${BUILDER_IMAGE} is impd's`);
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
      await Bun.write(join(ctx.dataDir, 'images', BUILDER_IMAGE, 'rootfs.ext4'), 'rootfs');

      await createImage(ctx.db, {
        name: BUILDER_IMAGE,
        ref: `${BUILDER_IMAGE}:latest`,
        digest: `sha256:${BUILDER_IMAGE}`,
        sizeBytes: 6,
      });
    },
    log: () => {},
  });

  await Bun.write(join(ctx.dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'base',
    ref: 'base:latest',
    digest: 'sha256:base',
    sizeBytes: 6,
  });

  const building = builders.withBuilder(new AbortController().signal, () =>
    Promise.resolve('built'),
  );

  expect(building).rejects.toMatchObject({ code: 'CONFLICT' });

  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => imp.kind)).toStrictEqual(['user']);
  expect(imps[0]?.name).toMatch(/^imp-build-[a-z2-9]{8}$/v);
});
