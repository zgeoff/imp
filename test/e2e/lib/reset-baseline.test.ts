import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImpClient } from '../../../packages/client/src/index';
import { loadConfig } from '../../../packages/daemon/src/config';
import { createImpd } from '../../../packages/daemon/src/create-impd';
import { createImage } from '../../../packages/daemon/src/db/images';
import { openDatabase } from '../../../packages/daemon/src/db/open-database';
import {
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '../../../packages/daemon/src/storage/data-layout';
import { createXfsBackend } from '../../../packages/daemon/src/storage/xfs-backend';
import { buildStubCpuCgroups } from '../../../packages/daemon/src/test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../../../packages/daemon/src/test-utils/build-stub-vmm';
import { findFreePorts } from '../../../packages/daemon/src/test-utils/find-free-ports';
import { resetBaseline } from './reset-baseline';

// impd's real app on the stub VMM, as the dev instance runs it, with the
// in-process client the reset drives
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'reset-baseline-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one
  const config = {
    ...loadConfig({
      IMP_DATA_DIR: dataDir,
      IMP_JAILER: 'false',
      IMP_BOOT_TEMPLATES: 'false',
      IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
    }),

    // a new disk stays the size of its image: the plain-copy clone copies
    // every byte
    defaultDiskBytes: 0,
  };

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  const impd = await createImpd(config, {
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

    // Firecracker, the kernel and the CPU as this host reports them, which a
    // snapshot must match to load
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

  const client = createImpClient({
    url: 'http://impd.test',
    token: 'root-token',
    fetch: (request) => impd.api.app.handle(request),
  });

  // the image an imp boots from when it names none, as impd's image
  // service leaves it: its rootfs under its digest
  await Bun.write(join(dataDir, 'images', 'ubuntu', 'rootfs.ext4'), 'rootfs');

  await createImage(db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });

  return { client, db, dataDir };
}

test('it removes the imps a journey named with its prefix, with their checkpoints and leases', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'e2e-x-dev' });
  const checkpoint = await ctx.client.checkpoints.create({ name: 'e2e-x-dev', label: 'cp1' });

  await ctx.client.leases.acquire({ name: 'e2e-x-dev', label: 'job', ttlSeconds: 120 });

  const checkpointDisk = join(
    ctx.dataDir,
    'imps',
    imp.id,
    'checkpoints',
    checkpoint.id,
    'disk.ext4',
  );

  const impsBefore = await ctx.client.imps.list();
  const leasesBefore = await ctx.client.leases.list({});

  const hadCheckpointDisk = existsSync(checkpointDisk);

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const imps = await ctx.client.imps.list();
  const leases = await ctx.client.leases.list({});

  expect(impsBefore.map((row) => row.name)).toStrictEqual(['e2e-x-dev']);
  expect(leasesBefore.map((lease) => lease.owner.label)).toStrictEqual(['job']);
  expect(hadCheckpointDisk).toBeTrue();
  expect(imps).toBeEmpty();
  expect(leases).toBeEmpty();
  expect(existsSync(checkpointDisk)).toBeFalse();
});

test('it removes the networks a journey named with its prefix', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'e2e-x-lab' });

  const before = await ctx.client.networks.list();

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const after = await ctx.client.networks.list();

  expect(before.map((network) => network.name)).toStrictEqual(['e2e-x-lab']);
  expect(after).toBeEmpty();
});

test('it removes the secrets a journey named with its prefix, and their grants to other imps', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'e2e-x-gh', kind: 'github', value: 'ghp_e2e' });
  await ctx.client.grants.add({ name: 'dev', secret: 'e2e-x-gh' });

  const secretsBefore = await ctx.client.secrets.list();
  const grantsBefore = await ctx.client.grants.list({ name: 'dev' });

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const secrets = await ctx.client.secrets.list();
  const grants = await ctx.client.grants.list({ name: 'dev' });

  expect(secretsBefore.map((secret) => secret.name)).toStrictEqual(['e2e-x-gh']);
  expect(grantsBefore).toStrictEqual(['e2e-x-gh']);
  expect(secrets).toBeEmpty();
  expect(grants).toBeEmpty();
});

test('it removes a prefixed imp together with the grants it holds', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'e2e-x-dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_owner' });
  await ctx.client.grants.add({ name: 'e2e-x-dev', secret: 'gh' });

  const grantsBefore = await ctx.client.grants.list({ name: 'e2e-x-dev' });

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const secrets = await ctx.client.secrets.list();

  expect(grantsBefore).toStrictEqual(['gh']);
  expect(secrets.map((secret) => secret.imps)).toStrictEqual([[]]);
});

test('it removes the tokens a journey named with its prefix', async () => {
  const ctx = await setupTest();

  await ctx.client.tokens.create({ name: 'e2e-x-reader', scope: 'read' });

  const before = await ctx.client.tokens.list();

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const after = await ctx.client.tokens.list();

  expect(before.map((token) => token.name)).toStrictEqual(['e2e-x-reader']);
  expect(after).toBeEmpty();
});

test('it removes the OAuth clients a journey named with its prefix', async () => {
  const ctx = await setupTest();

  await ctx.client.oauth.clients.add({
    name: 'e2e-x-conn',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
  });

  const before = await ctx.client.oauth.clients.list();

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const after = await ctx.client.oauth.clients.list();

  expect(before.map((client) => client.name)).toStrictEqual(['e2e-x-conn']);
  expect(after).toBeEmpty();
});

test('it removes the images a journey named with its prefix, after the imps that boot them', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'e2e-x-img', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'e2e-x-img',
    ref: 'x:1',
    digest: 'sha256:e2e-x-img',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'e2e-x-dev', image: 'e2e-x-img' });

  const before = await ctx.client.images.list();

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const after = await ctx.client.images.list();

  expect(before.map((image) => image.name)).toIncludeSameMembers(['ubuntu', 'e2e-x-img']);
  expect(after.map((image) => image.name)).toStrictEqual(['ubuntu']);
});

test('it removes the templates a journey made from its imps', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'e2e-x-dev' });
  await ctx.client.images.add({ imp: 'e2e-x-dev', name: 'e2e-x-golden' });

  const before = await ctx.client.images.list();

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const after = await ctx.client.images.list();

  expect(before.map((image) => image.name)).toIncludeSameMembers(['ubuntu', 'e2e-x-golden']);
  expect(after.map((image) => image.name)).toStrictEqual(['ubuntu']);
});

test('it removes the broker test upstreams file a journey wrote', async () => {
  const ctx = await setupTest();

  const upstreams = join(ctx.dataDir, 'broker-test-upstreams.json');

  await Bun.write(upstreams, '{"ca":"","upstreams":{}}');

  const hadUpstreams = existsSync(upstreams);

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  expect(hadUpstreams).toBeTrue();
  expect(existsSync(upstreams)).toBeFalse();
});

test('it removes what any of several prefixes names', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'e2e-x-lab' });
  await ctx.client.networks.create({ name: 'e2e-y-lab' });

  const before = await ctx.client.networks.list();

  await resetBaseline({
    client: ctx.client,
    prefixes: ['e2e-x-', 'e2e-y-'],
    dataDir: ctx.dataDir,
  });

  const after = await ctx.client.networks.list();

  expect(before.map((network) => network.name)).toIncludeSameMembers(['e2e-x-lab', 'e2e-y-lab']);
  expect(after).toBeEmpty();
});

test('it never removes what another owner named, a near-miss prefix included', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'e2e-tiny-0123abcd', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'e2e-tiny-0123abcd',
    ref: 'tiny:1',
    digest: 'sha256:e2e-tiny-0123abcd',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'e2e-y-dev', image: 'e2e-tiny-0123abcd' });
  await ctx.client.imps.create({ name: 'e2e-xy-dev' });
  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.networks.create({ name: 'e2e-xy-lab' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_owner' });
  await ctx.client.tokens.create({ name: 'reader', scope: 'read' });
  await ctx.client.tokens.create({ name: 'e2e-xy-reader', scope: 'read' });

  await ctx.client.oauth.clients.add({
    name: 'conn',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
  });

  await resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir });

  const imps = await ctx.client.imps.list();
  const images = await ctx.client.images.list();
  const networks = await ctx.client.networks.list();
  const secrets = await ctx.client.secrets.list();
  const tokens = await ctx.client.tokens.list();
  const clients = await ctx.client.oauth.clients.list();

  expect(imps.map((imp) => imp.name)).toIncludeSameMembers(['e2e-y-dev', 'e2e-xy-dev']);
  expect(images.map((image) => image.name)).toIncludeSameMembers(['ubuntu', 'e2e-tiny-0123abcd']);
  expect(networks.map((network) => network.name)).toIncludeSameMembers(['lab', 'e2e-xy-lab']);
  expect(secrets.map((secret) => secret.name)).toStrictEqual(['gh']);
  expect(tokens.map((token) => token.name)).toIncludeSameMembers(['reader', 'e2e-xy-reader']);
  expect(clients.map((client) => client.name)).toStrictEqual(['conn']);
});

test('it fails when impd refuses to remove what the prefix names', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.dataDir, 'images', 'e2e-x-img', 'rootfs.ext4'), 'rootfs');

  await createImage(ctx.db, {
    name: 'e2e-x-img',
    ref: 'x:1',
    digest: 'sha256:e2e-x-img',
    sizeBytes: 6,
  });

  await ctx.client.imps.create({ name: 'dev', image: 'e2e-x-img' });

  expect(
    resetBaseline({ client: ctx.client, prefixes: ['e2e-x-'], dataDir: ctx.dataDir }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});
