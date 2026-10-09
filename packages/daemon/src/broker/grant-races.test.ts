import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { buildMockBrokerRule } from '@imp/api/test-utils/build-mock-broker-rule';
import { invariant } from '@imp/test-utils/invariant';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { createImage } from '../db/images';
import { findImpByName } from '../db/imps';
import { openDatabase } from '../db/open-database';
import { listGrantNames, listGrantedRules } from '../db/secrets';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';

// Grants made, revoked, copied and changed at the same time: each race ends
// as one serial order would, and no imp ever holds two credentials for one
// host (docs/guides/connectors.md#secrets-and-grants).

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'grant-races-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // no jailer, no boot template; each resolver takes a free port; a new
  // disk stays the size of its image, as small as /tmp needs
  const config = {
    ...loadConfig({
      IMP_DATA_DIR: dataDir,
      IMP_JAILER: 'false',
      IMP_BOOT_TEMPLATES: 'false',
      IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
    }),
    defaultDiskBytes: 0,
  };

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  // the default image, which every imp the tests create boots
  await Bun.write(join(dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(db, { name: 'base', ref: 'base:latest', digest: 'sha256:base', sizeBytes: 6 });

  const vmm = buildStubVmm();

  // impd's log lines, which say why a fork went without a grant
  const logs: string[] = [];

  const impd = await createImpd(config, {
    db,
    rootToken: 'root-token',
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
    systemFiles: {
      kernelPath: join(dataDir, 'system', 'vmlinux'),
      systemDrivePath,
      info: {
        guestKernel: { version: '6.1.188', sha256: 'a'.repeat(64) },
        systemDrive: { sha256: drive },
      },
    },
    readDiskSpace: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }),
    log: (line) => {
      logs.push(line);
    },
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

  const client: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: 'Bearer root-token' },
      fetch: (request) => impd.api.app.handle(request),
    }),
  );

  return { db, impd, client, logs };
}

test('it makes exactly one of two clashing grants made at once, and refuses the other', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-race' });

  await ctx.client.secrets.add({
    name: 'gh-api',
    kind: 'custom',
    value: 'sk-synthetic-race',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
  });

  const results = await Promise.allSettled([
    ctx.client.grants.add({ name: 'dev', secret: 'gh' }),
    ctx.client.grants.add({ name: 'dev', secret: 'gh-api' }),
  ]);

  const dev = await findImpByName(ctx.db, 'dev');

  invariant(dev);

  const granted = await listGrantedRules(ctx.db, dev.id);

  const hosts = granted.map((each) => each.rule.host);

  const left = await ctx.client.grants.list({ name: 'dev' });

  expect(results).toIncludeSameMembers([
    { status: 'fulfilled', value: {} },
    { status: 'rejected', reason: expect.toContainEntry(['code', 'CONFLICT']) },
  ]);

  expect(left).toStrictEqual([expect.toBeOneOf(['gh', 'gh-api'])]);
  expect(new Set(hosts).size).toBe(hosts.length);
});

test('it ends a grant and a revoke made at once as one of the two orders', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-race' });

  const results = await Promise.allSettled([
    ctx.client.grants.add({ name: 'dev', secret: 'gh' }),
    ctx.client.grants.delete({ name: 'dev', secret: 'gh' }),
  ]);

  const left = await ctx.client.grants.list({ name: 'dev' });

  // one outcome of one order: grant then revoke leaves nothing; revoke first
  // finds no grant and the grant stays, so the results and the grants left
  // are checked together
  const outcome: unknown = { results, left };

  expect(outcome).toBeOneOf([
    {
      results: [
        { status: 'fulfilled', value: {} },
        { status: 'fulfilled', value: {} },
      ],
      left: [],
    },
    {
      results: [
        { status: 'fulfilled', value: {} },
        { status: 'rejected', reason: expect.toContainEntry(['code', 'NOT_FOUND']) },
      ],
      left: ['gh'],
    },
  ]);
});

test('it skips the clashing copy when a fork gets a grant while its source’s are copied', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.imps.create({ name: 'dev' });
  const copy = await ctx.client.imps.create({ name: 'copy' });

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-race' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-race' });

  await ctx.client.secrets.add({
    name: 'gh-api',
    kind: 'custom',
    value: 'sk-synthetic-race',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  // the copy as a fork makes it, a grant on the fork, and a grant on the
  // source, all at once
  const results = await Promise.allSettled([
    ctx.impd.broker.createForkGrants(dev, copy, null),
    ctx.client.grants.add({ name: 'copy', secret: 'gh-api' }),
    ctx.client.grants.add({ name: 'dev', secret: 'npm' }),
  ]);

  const granted = await listGrantedRules(ctx.db, copy.id);

  const hosts = granted.map((each) => each.rule.host);

  const copied = await ctx.client.grants.list({ name: 'copy' });

  const skipped = ctx.logs.filter((line) => line.includes('forked without grant'));

  // the copy, the fork's own grant and the skip log follow from one serial
  // order (copy first, or the fork's gh-api first; npm before or after), so
  // they are checked together
  const outcome: unknown = {
    copy: results[0],
    forkGrant: results[1],
    copied,
    skipped,
  };

  expect(outcome).toBeOneOf([
    {
      copy: { status: 'fulfilled', value: { notCopied: [], error: null } },
      forkGrant: { status: 'rejected', reason: expect.toContainEntry(['code', 'CONFLICT']) },
      copied: ['gh'],
      skipped: [],
    },
    {
      copy: { status: 'fulfilled', value: { notCopied: [], error: null } },
      forkGrant: { status: 'rejected', reason: expect.toContainEntry(['code', 'CONFLICT']) },
      copied: ['gh', 'npm'],
      skipped: [],
    },
    {
      copy: {
        status: 'fulfilled',
        value: { notCopied: [{ secret: 'gh', reason: 'clash' }], error: null },
      },
      forkGrant: { status: 'fulfilled', value: {} },
      copied: ['gh-api'],
      skipped: [
        'impd: copy: forked without grant gh of dev: it has another credential for that host',
      ],
    },
    {
      copy: {
        status: 'fulfilled',
        value: { notCopied: [{ secret: 'gh', reason: 'clash' }], error: null },
      },
      forkGrant: { status: 'fulfilled', value: {} },
      copied: ['gh-api', 'npm'],
      skipped: [
        'impd: copy: forked without grant gh of dev: it has another credential for that host',
      ],
    },
  ]);

  expect(results[2]).toStrictEqual({ status: 'fulfilled', value: {} });
  expect(new Set(hosts).size).toBe(hosts.length);
});

test('it drops the old grant of a rebind onto a host granted before it', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-race' });

  await ctx.client.secrets.add({
    name: 'other',
    kind: 'custom',
    value: 'sk-synthetic-race',
    rules: [buildMockBrokerRule({ host: 'other.example.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'other' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  await ctx.client.secrets.add({
    name: 'other',
    kind: 'custom',
    value: 'sk-synthetic-race-2',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
    replace: true,
    rebind: true,
  });

  const left = await ctx.client.grants.list({ name: 'dev' });

  expect(left).toStrictEqual(['gh']);
});

test('it grants a host after a rebind onto it dropped the old grant', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-race' });

  await ctx.client.secrets.add({
    name: 'other',
    kind: 'custom',
    value: 'sk-synthetic-race',
    rules: [buildMockBrokerRule({ host: 'other.example.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'other' });

  await ctx.client.secrets.add({
    name: 'other',
    kind: 'custom',
    value: 'sk-synthetic-race-2',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
    replace: true,
    rebind: true,
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const left = await ctx.client.grants.list({ name: 'dev' });

  expect(left).toStrictEqual(['gh']);
});

test('it ends a rebind and a revoke made at once with no grant left', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.secrets.add({
    name: 'other',
    kind: 'custom',
    value: 'sk-synthetic-race',
    rules: [buildMockBrokerRule({ host: 'other.example.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'other' });

  const results: unknown = await Promise.allSettled([
    ctx.client.secrets.add({
      name: 'other',
      kind: 'custom',
      value: 'sk-synthetic-race-2',
      rules: [buildMockBrokerRule({ host: 'api.github.com' })],
      replace: true,
      rebind: true,
    }),
    ctx.client.grants.delete({ name: 'dev', secret: 'other' }),
  ]);

  const left = await ctx.client.grants.list({ name: 'dev' });

  // revoke first, then a rebind with nothing to drop; or the rebind drops
  // the grant and the revoke finds none
  expect(results).toBeOneOf([
    [
      {
        status: 'fulfilled',
        value: {
          name: 'other',
          kind: 'custom',
          rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
          imps: [],
          createdAt: expect.any(Date) as unknown,
          droppedGrants: 0,
        },
      },
      { status: 'fulfilled', value: {} },
    ],
    [
      {
        status: 'fulfilled',
        value: {
          name: 'other',
          kind: 'custom',
          rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
          imps: [],
          createdAt: expect.any(Date) as unknown,
          droppedGrants: 1,
        },
      },
      { status: 'rejected', reason: expect.toContainEntry(['code', 'NOT_FOUND']) },
    ],
  ]);

  expect(left).toStrictEqual([]);
});

test('it keeps the grant that was there when a clashing one is refused', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-race' });

  await ctx.client.secrets.add({
    name: 'gh-api',
    kind: 'custom',
    value: 'sk-synthetic-race',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const clash = ctx.client.grants.add({ name: 'dev', secret: 'gh-api' });

  expect(clash).rejects.toMatchObject({ code: 'CONFLICT' });

  const kept = await ctx.client.grants.list({ name: 'dev' });

  expect(kept).toStrictEqual(['gh']);
});

test('it makes one row for the same grant made twice at once', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.secrets.add({
    name: 'gh-api',
    kind: 'custom',
    value: 'sk-synthetic-race',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
  });

  const results = await Promise.all([
    ctx.client.grants.add({ name: 'dev', secret: 'gh-api' }),
    ctx.client.grants.add({ name: 'dev', secret: 'gh-api' }),
  ]);

  const rows = await listGrantNames(ctx.db, dev.id);

  expect(results).toStrictEqual([{}, {}]);
  expect(rows).toStrictEqual(['gh-api']);
});
