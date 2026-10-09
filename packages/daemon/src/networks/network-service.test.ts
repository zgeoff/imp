import { expect, mock, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { createImage } from '../db/images';
import { findImpByName, listImps, updateImpMove } from '../db/imps';
import { openDatabase } from '../db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubNft } from '../test-utils/build-stub-nft';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'network-service-'));

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

    // a new disk stays its image's size: a clone off XFS copies every byte,
    // and a fork of a 32 GiB disk would take tens of seconds
    defaultDiskBytes: 0,
  };

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();
  const nft = buildStubNft();
  const flushPair = mock<(first: string, second: string) => Promise<void>>(() => Promise.resolve());

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

    // the firewall the network sets live in, and the conntrack flush of a
    // pair that no longer shares a network
    egress: {
      runNft: nft.runNft,
      flushConnections: () => Promise.resolve(),
      flushPair,
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
  });

  stack.defer(() => {
    impd.diskUsage.stop();
  });

  // the image every imp here boots
  await Bun.write(join(dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(db, { name: 'base', ref: 'base:latest', digest: 'sha256:base', sizeBytes: 6 });

  const client: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: 'Bearer root-token' },
      fetch: (request) => impd.api.app.handle(request),
    }),
  );

  return { db, impd, client, nft, flushPair };
}

test('it puts the imps on a network into its set', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'db' });
  await ctx.client.networks.join({ network: 'lab', name: 'db' });

  expect(ctx.nft.scripts.at(-1)).toInclude('elements = { "imp1" . 10.66.0.6, "imp0" . 10.66.0.2 }');
});

test('it answers a second join with the network as it stands', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'db' });
  await ctx.client.networks.join({ network: 'lab', name: 'db' });

  const again = await ctx.client.networks.join({ network: 'lab', name: 'db' });

  expect(again).toStrictEqual({
    name: 'lab',
    imps: ['db', 'web'],
    createdAt: expect.toBeValidDate(),
    warning: null,
  });
});

test('it lists each network with its imps', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'db' });
  await ctx.client.networks.join({ network: 'lab', name: 'db' });

  const networks = await ctx.client.networks.list();

  expect(networks).toStrictEqual([
    { name: 'lab', imps: ['db', 'web'], createdAt: expect.toBeValidDate() },
  ]);
});

test('it refuses a network whose name is taken with CONFLICT', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });

  expect(ctx.client.networks.create({ name: 'lab' })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

test('it refuses a join to a network that does not exist with NOT_FOUND', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'web' });

  expect(ctx.client.networks.join({ network: 'nope', name: 'web' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'network', name: 'nope' },
  });
});

test('it refuses a join of an imp that does not exist with NOT_FOUND', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });

  expect(ctx.client.networks.join({ network: 'lab', name: 'nope' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'nope' },
  });
});

test('it refuses a leave of an imp that does not exist with NOT_FOUND', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });

  expect(ctx.client.networks.leave({ network: 'lab', name: 'nope' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'nope' },
  });
});

test('it refuses a delete of a network that does not exist with NOT_FOUND', async () => {
  const ctx = await setupTest();

  expect(ctx.client.networks.delete({ name: 'nope' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'network', name: 'nope' },
  });
});

test('it takes a leaving imp out of the set', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'db' });
  await ctx.client.networks.join({ network: 'lab', name: 'db' });

  const left = await ctx.client.networks.leave({ network: 'lab', name: 'db' });

  expect(left.imps).toStrictEqual(['web']);
  expect(ctx.nft.scripts.at(-1)).toInclude('elements = { "imp0" . 10.66.0.2 }');
});

test('it drops the flows of a pair that a leave parts', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'db' });
  await ctx.client.networks.join({ network: 'lab', name: 'db' });
  await ctx.client.networks.leave({ network: 'lab', name: 'db' });

  expect(ctx.flushPair).toHaveBeenCalledExactlyOnceWith('10.66.0.2', '10.66.0.6');
});

test('it drops no flows for a leave by an imp that is not on the network', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'db' });
  await ctx.client.networks.leave({ network: 'lab', name: 'db' });

  expect(ctx.flushPair).not.toHaveBeenCalled();
});

test('it keeps the flows of a pair that still shares another network', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.networks.create({ name: 'ops' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab', 'ops'] });
  await ctx.client.imps.create({ name: 'db', networks: ['lab', 'ops'] });
  await ctx.client.networks.delete({ name: 'lab' });

  expect(ctx.flushPair).not.toHaveBeenCalled();
});

test('it drops the flows of a pair once no network joins them', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.networks.create({ name: 'ops' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab', 'ops'] });
  await ctx.client.imps.create({ name: 'db', networks: ['lab', 'ops'] });
  await ctx.client.networks.delete({ name: 'lab' });
  await ctx.client.networks.delete({ name: 'ops' });

  expect(ctx.flushPair).toHaveBeenCalledExactlyOnceWith('10.66.0.2', '10.66.0.6');
});

test('it takes a deleted network’s set out of the table', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.networks.delete({ name: 'lab' });

  expect(ctx.nft.scripts.at(-1)).not.toInclude('@net0');
});

test('it leaves no imp when a create names a network that does not exist', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'web' });

  const refused = ctx.client.imps.create({ name: 'api', networks: ['nope'] });

  expect(refused).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'network', name: 'nope' },
  });

  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => imp.name)).toStrictEqual(['web']);
});

test('it refuses a create on a network to a token limited to other imps', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });

  const created = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const limited: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${created.secret}` },
      fetch: (request) => ctx.impd.api.app.handle(request),
    }),
  );

  expect(limited.imps.create({ name: 'dev-a', networks: ['lab'] })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });

  const imps = await listImps(ctx.db);

  expect(imps).toStrictEqual([]);
});

test('it refuses a join to a token limited to other imps', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });

  const created = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const limited: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${created.secret}` },
      fetch: (request) => ctx.impd.api.app.handle(request),
    }),
  );

  await limited.imps.create({ name: 'dev-a' });

  expect(limited.networks.join({ network: 'lab', name: 'dev-a' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });

  const networks = await ctx.client.networks.list();

  expect(networks[0]?.imps).toStrictEqual([]);
});

test('it lets a root token put an imp on a network', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'dev-a' });

  const joined = await ctx.client.networks.join({ network: 'lab', name: 'dev-a' });

  expect(joined.imps).toStrictEqual(['dev-a']);
});

test('it puts the membership back when nft refuses a leave’s table', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'db', networks: ['lab'] });

  ctx.nft.refuse({ reason: 'Error: Could not process rule', times: 1 });

  expect(ctx.client.networks.leave({ network: 'lab', name: 'db' })).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
  });

  const networks = await ctx.client.networks.list();

  expect(networks[0]?.imps).toStrictEqual(['db', 'web']);
  expect(ctx.flushPair).not.toHaveBeenCalled();
});

test('it puts back every member, the latest join included, when nft refuses a delete', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'db' });
  await ctx.client.networks.join({ network: 'lab', name: 'db' });

  ctx.nft.refuse({ reason: 'Error: Could not process rule', times: 1 });

  expect(ctx.client.networks.delete({ name: 'lab' })).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
  });

  const networks = await ctx.client.networks.list();

  expect(networks.map((network) => [network.name, network.imps])).toStrictEqual([
    ['lab', ['db', 'web']],
  ]);
});

test('it takes a destroyed imp out of its networks’ sets', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'db', networks: ['lab'] });
  await ctx.client.imps.destroy({ name: 'db' });

  expect(ctx.nft.scripts.at(-1)).toInclude('elements = { "imp0" . 10.66.0.2 }');
});

test('it takes a destroyed imp off its networks', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'db', networks: ['lab'] });
  await ctx.client.imps.destroy({ name: 'db' });

  const networks = await ctx.client.networks.list();

  expect(networks[0]?.imps).toStrictEqual(['web']);
});

test('it puts a fork on no network', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.fork({ source: 'web', name: 'copy' });

  const networks = await ctx.client.networks.list();

  expect(networks[0]?.imps).toStrictEqual(['web']);
});

test('it warns a box imp that joins next to an open one', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'db' });
  await ctx.client.imps.setPolicy({ name: 'db', policy: { mode: 'box', allow: [] } });

  const joined = await ctx.client.networks.join({ network: 'lab', name: 'db' });

  expect(joined.warning).toBe(
    'db is box, but web on lab is open and can relay for it: a public, box or none imp trusts its open peers',
  );
});

test('it warns an open imp that joins next to a box one', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'db', networks: ['lab'] });
  await ctx.client.imps.setPolicy({ name: 'db', policy: { mode: 'box', allow: [] } });
  await ctx.client.imps.create({ name: 'web' });

  const joined = await ctx.client.networks.join({ network: 'lab', name: 'web' });

  expect(joined.warning).toBe(
    'web is open, so db on lab can reach anything through it: a public, box or none imp trusts its open peers',
  );
});

test('it says “are open” when several open imps can relay for a box imp', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'api', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'db' });
  await ctx.client.imps.setPolicy({ name: 'db', policy: { mode: 'box', allow: [] } });

  const joined = await ctx.client.networks.join({ network: 'lab', name: 'db' });

  expect(joined.warning).toBe(
    'db is box, but api, web on lab are open and can relay for it: a public, box or none imp trusts its open peers',
  );
});

test('it says “are public” when several public imps can relay for a none imp', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'api', networks: ['lab'] });
  await ctx.client.imps.setPolicy({ name: 'web', policy: { mode: 'public', allow: [] } });
  await ctx.client.imps.setPolicy({ name: 'api', policy: { mode: 'public', allow: [] } });
  await ctx.client.imps.create({ name: 'db' });
  await ctx.client.imps.setPolicy({ name: 'db', policy: { mode: 'none', allow: [] } });

  const joined = await ctx.client.networks.join({ network: 'lab', name: 'db' });

  expect(joined.warning).toBe(
    'db is none, but api, web on lab are public and can relay for it to the internet: a box or none imp trusts its public peers',
  );
});

test('it gives no warning to a join of imps of one policy', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'db' });

  const joined = await ctx.client.networks.join({ network: 'lab', name: 'db' });

  expect(joined.warning).toBeNull();
});

test('it warns a public imp next to an open one that the open one can relay for it', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'db', networks: ['lab'] });
  await ctx.client.imps.setPolicy({ name: 'web', policy: { mode: 'public', allow: [] } });

  const warnings = await ctx.client.networks.warnings({ name: 'web' });

  expect(warnings).toStrictEqual([
    'web is public, but db on lab is open and can relay for it: a public, box or none imp trusts its open peers',
  ]);
});

test('it warns a none imp next to a public one that the public one can relay for it', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'db', networks: ['lab'] });
  await ctx.client.imps.setPolicy({ name: 'web', policy: { mode: 'public', allow: [] } });
  await ctx.client.imps.setPolicy({ name: 'db', policy: { mode: 'none', allow: [] } });

  const warnings = await ctx.client.networks.warnings({ name: 'db' });

  expect(warnings).toStrictEqual([
    'db is none, but web on lab is public and can relay for it to the internet: a box or none imp trusts its public peers',
  ]);
});

test('it warns a public imp next to a none one that the none one can reach the internet through it', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'db', networks: ['lab'] });
  await ctx.client.imps.setPolicy({ name: 'web', policy: { mode: 'public', allow: [] } });
  await ctx.client.imps.setPolicy({ name: 'db', policy: { mode: 'none', allow: [] } });

  const warnings = await ctx.client.networks.warnings({ name: 'web' });

  expect(warnings).toStrictEqual([
    'web is public, so db on lab can reach the internet through it: a box or none imp trusts its public peers',
  ]);
});

test('it has no warnings for an imp on a network of one policy', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.client.imps.create({ name: 'db', networks: ['lab'] });

  const warnings = await ctx.client.networks.warnings({ name: 'db' });

  expect(warnings).toStrictEqual([]);
});

test('it refuses warnings for an imp that does not exist with NOT_FOUND', async () => {
  const ctx = await setupTest();

  expect(ctx.client.networks.warnings({ name: 'nope' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'nope' },
  });
});

test('it makes a restore’s missing networks and names the ones it made', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });

  const written = await ctx.impd.networks.writeMissingNetworks(['lab', 'new']);
  const networks = await ctx.client.networks.list();

  expect(written.created).toStrictEqual(['new']);
  expect(networks.map((network) => network.name)).toStrictEqual(['lab', 'new']);
});

test('it removes the networks a failed restore made once they are empty', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.impd.networks.writeMissingNetworks(['lab', 'new']);
  await ctx.impd.networks.removeEmptyNetworks(['new']);

  const networks = await ctx.client.networks.list();

  expect(networks.map((network) => network.name)).toStrictEqual(['lab']);
});

test('it keeps a network with members that a failed restore names', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web', networks: ['lab'] });
  await ctx.impd.networks.removeEmptyNetworks(['lab']);

  const networks = await ctx.client.networks.list();

  expect(networks.map((network) => network.name)).toStrictEqual(['lab']);
});

test('it refuses a join of an imp a move marked with MOVING', async () => {
  const ctx = await setupTest();

  await ctx.client.networks.create({ name: 'lab' });
  await ctx.client.imps.create({ name: 'web' });

  const imp = await findImpByName(ctx.db, 'web');

  invariant(imp);

  await updateImpMove(ctx.db, imp.id, 'sending');

  expect(ctx.client.networks.join({ network: 'lab', name: 'web' })).rejects.toMatchObject({
    code: 'MOVING',
  });
});
