import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@imp/daemon/src/config';
import { createImpd } from '@imp/daemon/src/create-impd';
import { createImage } from '@imp/daemon/src/db/images';
import { openDatabase } from '@imp/daemon/src/db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from '@imp/daemon/src/storage/data-layout';
import { createXfsBackend } from '@imp/daemon/src/storage/xfs-backend';
import { buildStubCpuCgroups } from '@imp/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '@imp/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '@imp/daemon/src/test-utils/find-free-ports';
import { createImpClient } from '@zgeoff/imp-client';
import { buildStubOlderImpdFetch } from '../test-utils/build-stub-older-impd-fetch';
import { checkDockerBuildx } from '../test-utils/run-docker-build';
import { runImageAdd, runOnHostBuild } from './run-image-op';

// impd's real app, booted on stand-ins, and an in-process client of it that
// records each procedure it calls
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'cli-image-op-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one
  const config = loadConfig({
    IMP_DATA_DIR: dataDir,
    IMP_JAILER: 'false',
    IMP_BOOT_TEMPLATES: 'false',

    // a host build runs this machine's docker, as the stub VMM boots no builder
    IMP_BUILD_ISOLATION: 'host',
    IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
  });

  // the system drive impd boots imps with
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  const impd = await createImpd(config, {
    db,

    // the bearer the CLI sends
    rootToken: 'root-token',
    storage: createXfsBackend({
      dataDir,
      cloneFile: async (source, target) => {
        // keeps the imp's sparse disk sparse, which a template copies
        await Bun.spawn(['cp', '--sparse=always', source, target]).exited;
      },
    }),
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
  });

  stack.defer(() => impd.broker.stop());

  stack.defer(() => {
    impd.egress.stop();
    impd.diskUsage.stop();
  });

  // the image the imp is created from
  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  const sendRequest = (request: Request) => impd.api.app.handle(request);

  // the procedure of each call the client sends, such as `system/info`
  const calls: string[] = [];

  const client = createImpClient({
    url: 'http://impd.test',
    token: 'root-token',
    fetch: (request) => {
      calls.push(new URL(request.url).pathname.slice('/rpc/'.length));

      return sendRequest(request);
    },
  });

  return { client, sendRequest, calls };
}

test('#runImageAdd makes a template from an imp through the stream of a current impd', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const image = await runImageAdd(ctx.client, { imp: 'box', name: 'tpl' }, 'imp template create');

  const received: unknown = image;

  expect(received).toStrictEqual({
    id: expect.any(String) as unknown,
    name: 'tpl',
    ref: 'imp:box',
    digest: expect.stringMatching(/^imp-/u) as unknown,
    source: 'imp',
    createdAt: expect.toBeValidDate() as unknown,
    sizeBytes: expect.any(Number) as unknown,
  });

  expect(ctx.calls).toStrictEqual(['imps/create', 'system/info', 'images/addStream']);
});

test.skipIf(!checkDockerBuildx())(
  '#runOnHostBuild builds an image on the host through the stream of a current impd',
  async () => {
    const ctx = await setupTest();
    const contextDir = await mkdtemp(join(tmpdir(), 'cli-image-op-ctx-'));

    onTestFinished(() => rm(contextDir, { recursive: true, force: true }));

    await Bun.write(join(contextDir, 'Dockerfile'), 'FROM scratch\nCOPY hello /hello\n');
    await Bun.write(join(contextDir, 'hello'), 'hi');

    const built = await runOnHostBuild(ctx.client, { contextDir, name: 'img' });

    const received: unknown = built;

    expect(received).toStrictEqual({
      id: expect.any(String) as unknown,
      name: 'img',
      ref: 'imp/img:latest',
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as unknown,
      source: 'oci',
      createdAt: expect.toBeValidDate() as unknown,
      sizeBytes: expect.any(Number) as unknown,
    });

    expect(ctx.calls).toStrictEqual(['system/info', 'images/buildStream']);
  },
  120_000,
);

test('#runOnHostBuild passes on a current impd’s refusal of a host build', async () => {
  const ctx = await setupTest();

  const building = runOnHostBuild(ctx.client, { contextDir: '/nonexistent/ctx', name: 'img' });

  expect(building).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.stringContaining(
      'build context /nonexistent/ctx does not exist on the impd host',
    ) as unknown,
  });
});

test('#runImageAdd adds through the call that answers at the end on an impd from before imageOpStream', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const older = buildStubOlderImpdFetch(ctx.sendRequest, { withoutFeatures: ['imageOpStream'] });

  const added = await runImageAdd(
    createImpClient({ url: 'http://impd.test', token: 'root-token', fetch: older.fetch }),
    { imp: 'box', name: 'tpl' },
    'imp template create',
  );

  const received: unknown = added;

  expect(received).toStrictEqual({
    id: expect.any(String) as unknown,
    name: 'tpl',
    ref: 'imp:box',
    digest: expect.stringMatching(/^imp-/u) as unknown,
    source: 'imp',
    createdAt: expect.toBeValidDate() as unknown,
    sizeBytes: expect.any(Number) as unknown,
  });

  expect(older.calls).toStrictEqual(['system/info', 'images/add']);
});

test.skipIf(!checkDockerBuildx())(
  '#runOnHostBuild builds through the call that answers at the end on an impd from before imageOpStream',
  async () => {
    const ctx = await setupTest();
    const contextDir = await mkdtemp(join(tmpdir(), 'cli-image-op-ctx-'));

    onTestFinished(() => rm(contextDir, { recursive: true, force: true }));

    await Bun.write(join(contextDir, 'Dockerfile'), 'FROM scratch\nCOPY hello /hello\n');
    await Bun.write(join(contextDir, 'hello'), 'hi');

    const older = buildStubOlderImpdFetch(ctx.sendRequest, {
      withoutFeatures: ['imageOpStream'],
    });

    const built = await runOnHostBuild(
      createImpClient({ url: 'http://impd.test', token: 'root-token', fetch: older.fetch }),
      { contextDir, name: 'img' },
    );

    const received: unknown = built;

    expect(received).toStrictEqual({
      id: expect.any(String) as unknown,
      name: 'img',
      ref: 'imp/img:latest',
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as unknown,
      source: 'oci',
      createdAt: expect.toBeValidDate() as unknown,
      sizeBytes: expect.any(Number) as unknown,
    });

    expect(older.calls).toStrictEqual(['system/info', 'images/build']);
  },
  120_000,
);

test('#runImageAdd rejects when impd faults by ending the stream before it answers the image', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box' });

  const faulty = buildStubOlderImpdFetch(ctx.sendRequest, {
    withoutEvents: { 'images/addStream': ['image'] },
  });

  const adding = runImageAdd(
    createImpClient({ url: 'http://impd.test', token: 'root-token', fetch: faulty.fetch }),
    { imp: 'box', name: 'tpl' },
    'imp template create',
  );

  expect(adding).rejects.toThrowWithMessage(
    Error,
    'impd ended the stream before it answered the image',
  );
});
