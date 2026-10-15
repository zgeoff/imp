import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import type { ImpContract } from '@impz/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { loadConfig } from './config';
import { createImpd } from './create-impd';
import type { ImpdDeps } from './create-impd';
import { createImage } from './db/images';
import { findImpByName } from './db/imps';
import { openDatabase } from './db/open-database';
import { buildImagePaths, buildSystemDrivePath, buildSystemDrivesDir } from './storage/data-layout';
import { createXfsBackend } from './storage/xfs-backend';
import { buildMockNewImage } from './test-utils/build-mock-new-image';
import { buildStubCpuCgroups } from './test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from './test-utils/build-stub-vmm';
import { findFreePorts } from './test-utils/find-free-ports';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'build-router-'));

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

  // impd boots with a root bearer; the client sends it
  const rootToken = faker.string.alphanumeric(32);

  const deps: ImpdDeps = {
    db,
    rootToken,
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
      headers: { authorization: `Bearer ${rootToken}` },
      fetch: (request) => impd.api.app.handle(request),
    }),
  );

  return { db, dataDir, impd, client };
}

test('#imps.setPolicy refuses a builder', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const setting = ctx.client.imps.setPolicy({
    name: 'imp-build-x',
    policy: { mode: 'open', allow: [] },
  });

  expect(setting).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('#exec.ticket refuses a builder', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const ticketing = ctx.client.exec.ticket({ name: 'imp-build-x' });

  expect(ticketing).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('#imps.fork refuses a builder as its source', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const forking = ctx.client.imps.fork({ source: 'imp-build-x', name: 'copy' });

  expect(forking).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('#imps.stop refuses a builder', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const stopping = ctx.client.imps.stop({ name: 'imp-build-x' });

  expect(stopping).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('#checkpoints.create refuses a builder', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const checkpointing = ctx.client.checkpoints.create({ name: 'imp-build-x' });

  expect(checkpointing).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('#images.add refuses a template of a builder', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const adding = ctx.client.images.add({ imp: 'imp-build-x', name: 'tpl' });

  expect(adding).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('#moves.prepare refuses a builder', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const preparing = ctx.client.moves.prepare({ name: 'imp-build-x' });

  expect(preparing).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('#imps.list leaves out a builder unless the caller asks for builders', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });
  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const listed = await ctx.client.imps.list();

  expect(listed.map((imp) => imp.name)).toStrictEqual(['dev']);
});

test('#imps.list lists a builder when the caller asks for builders', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });
  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const all = await ctx.client.imps.list({ builders: true });

  expect(all.map((imp) => [imp.name, imp.kind])).toStrictEqual([
    ['dev', 'user'],
    ['imp-build-x', 'builder'],
  ]);
});

test('#imps.get shows a builder by its name as a builder', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const info = await ctx.client.imps.get({ name: 'imp-build-x' });

  expect(info.kind).toBe('builder');
});

test('#imps.destroy removes a builder', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });
  await ctx.client.imps.destroy({ name: 'imp-build-x' });

  const gone = await findImpByName(ctx.db, 'imp-build-x');

  expect(gone).toBeUndefined();
});
