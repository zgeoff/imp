import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { loadConfig } from './config';
import { createImpd } from './create-impd';
import type { ImpdDeps } from './create-impd';
import { createImage } from './db/images';
import { findImpByName } from './db/imps';
import { openDatabase } from './db/open-database';
import { findSecret } from './db/secrets';
import { listTokenRecords } from './db/tokens';
import { buildSystemDrivePath, buildSystemDrivesDir } from './storage/data-layout';
import { createXfsBackend } from './storage/xfs-backend';
import { buildStubCpuCgroups } from './test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from './test-utils/build-stub-vmm';
import { findFreePorts } from './test-utils/find-free-ports';

// tokens.update: a token's grantable list changed in place
// (docs/guides/tokens.md#change-the-list), through the API as a client calls it.

// impd's real app on stub VMs, a root client, `sendToImpd` for the clients a
// test makes, and `gap`: its `once` runs in the next grant write, between the
// access check and the transaction, and then resets
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'token-update-'));

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
  const gap = { once: (): Promise<void> => Promise.resolve() };

  const deps: ImpdDeps = {
    db,

    // the bearer the root client sends
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

      // the race window: what a test sets runs once, then writes run on
      beforeGrantWrite: () => {
        const run = gap.once;

        gap.once = () => Promise.resolve();

        return run();
      },
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

  // the default image, which every imps.create boots when it names none
  await Bun.write(join(dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(db, { name: 'base', ref: 'base:latest', digest: 'sha256:base', sizeBytes: 6 });

  const sendToImpd = (request: Request) => impd.api.app.handle(request);

  const client: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: 'Bearer root-token' },
      fetch: sendToImpd,
    }),
  );

  return { db, config, deps, vmm, stack, impd, client, sendToImpd, gap };
}

test('it lets a host-wide manage token change another token’s list', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-119-1' });

  await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  const admin = await ctx.client.tokens.create({ name: 'admin', scope: 'manage' });

  const caller: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${admin.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  const updated = await caller.tokens.update({ name: 'agent', grantable: ['gh', 'npm'] });

  expect(updated.grantable).toStrictEqual(['gh', 'npm']);
});

test.each([
  [
    'a host-wide exec token',
    { scope: 'exec' as const },
    { code: 'FORBIDDEN', data: { reason: 'scope' } },
  ],
  [
    'a dev-* manage token',
    { scope: 'manage' as const, imps: ['dev-*'] },
    { code: 'FORBIDDEN', data: undefined },
  ],
  [
    'a dev-* manage token that may grant',
    { scope: 'manage' as const, imps: ['dev-*'], grantable: ['gh', 'npm'] },
    { code: 'FORBIDDEN', data: undefined },
  ],
])('it refuses a list change from %s', async (_label, options, refusal) => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-119-1' });

  await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  const made = await ctx.client.tokens.create({ name: 'caller', ...options });

  const caller: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  expect(caller.tokens.update({ name: 'agent', grantable: ['gh', 'npm'] })).rejects.toMatchObject(
    refusal,
  );
});

// the same rule as a list change: a grant on an imp outside every pattern
test('it lets a host-wide manage token grant on any imp', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-119-1' });

  const admin = await ctx.client.tokens.create({ name: 'admin', scope: 'manage' });

  const caller: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${admin.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  await caller.grants.add({ name: 'prod', secret: 'npm' });

  const grants = await ctx.client.grants.list({ name: 'prod' });

  expect(grants).toStrictEqual(['npm']);
});

test.each([
  [
    'a host-wide exec token',
    { scope: 'exec' as const },
    { code: 'FORBIDDEN', data: { reason: 'scope' } },
  ],
  [
    'a dev-* manage token',
    { scope: 'manage' as const, imps: ['dev-*'] },
    { code: 'FORBIDDEN', data: { reason: 'imp_out_of_scope' } },
  ],
  [
    'a dev-* manage token that may grant',
    { scope: 'manage' as const, imps: ['dev-*'], grantable: ['gh', 'npm'] },
    { code: 'FORBIDDEN', data: { reason: 'imp_out_of_scope' } },
  ],
])('it refuses a grant on prod from %s', async (_label, options, refusal) => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-119-1' });

  const made = await ctx.client.tokens.create({ name: 'caller', ...options });

  const caller: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  expect(caller.grants.add({ name: 'prod', secret: 'npm' })).rejects.toMatchObject(refusal);
});

test('it leaves the list as it was after a refused change', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });

  await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  const dev = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const caller: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${dev.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  await expect(caller.tokens.update({ name: 'agent', grantable: [] })).toReject();

  const tokens = await ctx.client.tokens.list();

  expect(tokens.find((token) => token.name === 'agent')?.grantable).toStrictEqual(['gh']);
});

test('it revokes a secret taken off the list on the token’s imps only', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'dev-b' });
  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-119-1' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh', 'npm'],
  });

  const agent: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  // made through the token, by the root token on one of its imps, and on an
  // imp outside its patterns
  await agent.grants.add({ name: 'dev-a', secret: 'gh' });
  await agent.grants.add({ name: 'dev-a', secret: 'npm' });
  await ctx.client.grants.add({ name: 'dev-b', secret: 'gh' });
  await ctx.client.grants.add({ name: 'prod', secret: 'gh' });

  const devA = await findImpByName(ctx.db, 'dev-a');
  const prod = await findImpByName(ctx.db, 'prod');

  invariant(devA);
  invariant(prod);

  const before = await ctx.impd.broker.isGranted(devA.id, 'api.github.com');
  const updated = await ctx.client.tokens.update({ name: 'agent', grantable: ['npm'] });
  const devAGrants = await ctx.client.grants.list({ name: 'dev-a' });
  const devBGrants = await ctx.client.grants.list({ name: 'dev-b' });
  const prodGrants = await ctx.client.grants.list({ name: 'prod' });
  const devAGithub = await ctx.impd.broker.isGranted(devA.id, 'api.github.com');
  const devANpm = await ctx.impd.broker.isGranted(devA.id, 'registry.npmjs.org');
  const prodGithub = await ctx.impd.broker.isGranted(prod.id, 'api.github.com');

  expect(before).toBeTrue();
  expect(updated.grantable).toStrictEqual(['npm']);
  expect(devAGrants).toStrictEqual(['npm']);
  expect(devBGrants).toStrictEqual([]);
  expect(prodGrants).toStrictEqual(['gh']);
  expect(devAGithub).toBeFalse();
  expect(devANpm).toBeTrue();
  expect(prodGithub).toBeTrue();
});

test('it refuses a grant of a secret taken off the list', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-119-1' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh', 'npm'],
  });

  await ctx.client.tokens.update({ name: 'agent', grantable: ['npm'] });

  const agent: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  expect(agent.grants.add({ name: 'dev-a', secret: 'gh' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'not_grantable' },
  });
});

test('it refuses a list entry a rebind left stale', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  // a rebind gives gh another generation, so the list no longer covers it
  await ctx.client.secrets.add({
    name: 'gh',
    kind: 'custom',
    value: 'sk-synthetic-119-0',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    replace: true,
    rebind: true,
  });

  const agent: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  expect(agent.grants.add({ name: 'dev-a', secret: 'gh' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'not_grantable' },
  });
});

test('it binds each entry to its secret’s generation at the update', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-119-1' });

  await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  // a rebind gives gh another generation than the list holds
  await ctx.client.secrets.add({
    name: 'gh',
    kind: 'custom',
    value: 'sk-synthetic-119-0',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    replace: true,
    rebind: true,
  });

  await ctx.client.tokens.update({ name: 'agent', grantable: ['gh', 'npm'] });

  const gh = await findSecret(ctx.db, 'gh');
  const npm = await findSecret(ctx.db, 'npm');
  const records = await listTokenRecords(ctx.db);

  invariant(gh);
  invariant(npm);

  expect(records.find((record) => record.name === 'agent')?.grantable).toStrictEqual([
    { name: 'gh', generation: gh.generation },
    { name: 'npm', generation: npm.generation },
  ]);
});

test('it binds the same generations as a token made after the update', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-119-1' });

  await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  await ctx.client.secrets.add({
    name: 'gh',
    kind: 'custom',
    value: 'sk-synthetic-119-0',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    replace: true,
    rebind: true,
  });

  await ctx.client.tokens.update({ name: 'agent', grantable: ['gh', 'npm'] });

  await ctx.client.tokens.create({
    name: 'fresh',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh', 'npm'],
  });

  const records = await listTokenRecords(ctx.db);

  const agent = records.find((record) => record.name === 'agent');
  const fresh = records.find((record) => record.name === 'fresh');

  invariant(agent);

  expect(fresh?.grantable).toStrictEqual(agent.grantable);
});

test('it lets the token grant each secret on its updated list', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'dev-b' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-119-1' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  await ctx.client.secrets.add({
    name: 'gh',
    kind: 'custom',
    value: 'sk-synthetic-119-0',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    replace: true,
    rebind: true,
  });

  await ctx.client.tokens.update({ name: 'agent', grantable: ['gh', 'npm'] });

  const agent: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  await agent.grants.add({ name: 'dev-a', secret: 'gh' });
  await agent.grants.add({ name: 'dev-b', secret: 'npm' });

  const devAGrants = await ctx.client.grants.list({ name: 'dev-a' });
  const devBGrants = await ctx.client.grants.list({ name: 'dev-b' });

  expect(devAGrants).toStrictEqual(['gh']);
  expect(devBGrants).toStrictEqual(['npm']);
});

test('it records each change in the API audit log, refused or made', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-119-1' });

  await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  const dev = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const caller: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${dev.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  await ctx.client.tokens.update({ name: 'agent', grantable: ['npm'] });

  await expect(caller.tokens.update({ name: 'agent', grantable: [] })).toReject();

  // what `imp audit --kind api` reads
  const calls = await ctx.client.audit.calls({});

  expect(
    calls
      .filter((call) => call.procedure === 'tokens.update')
      .map((call) => ({ actor: call.actor, actorName: call.actorName, outcome: call.outcome })),
  ).toIncludeSameMembers([
    { actor: 'token', actorName: 'root', outcome: 'ok' },
    { actor: 'token', actorName: 'dev', outcome: 'FORBIDDEN' },
  ]);

  expect(JSON.stringify(calls)).not.toContain('sk-synthetic-119');
});

test('it keeps the token’s id, hash and creation time through an update', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-119-1' });

  await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  const [before] = await listTokenRecords(ctx.db);

  invariant(before);

  await ctx.client.tokens.update({ name: 'agent', grantable: ['gh', 'npm'] });

  const [after] = await listTokenRecords(ctx.db);

  expect(after?.id).toBe(before.id);
  expect(after?.secretHash).toBe(before.secretHash);
  expect(after?.createdAt).toStrictEqual(before.createdAt);
});

test('it answers an update with the token and never its secret', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-119-1' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  const updated = await ctx.client.tokens.update({ name: 'agent', grantable: ['gh', 'npm'] });

  expect(updated.name).toBe('agent');
  expect(JSON.stringify(updated)).not.toContain(made.secret);
});

test('it lets the old bearer read the new list after an update', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-119-1' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  const agent: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  await ctx.client.tokens.update({ name: 'agent', grantable: ['gh', 'npm'] });

  const identity = await agent.tokens.whoami();

  expect(identity).toStrictEqual({
    kind: 'token',
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh', 'npm'],
  });
});

test('it keeps the updated list for the old bearer after a restart', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-119-1' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  await ctx.client.tokens.update({ name: 'agent', grantable: ['gh', 'npm'] });

  // the first impd still holds its resolver's port in this process
  const restarted = await createImpd(
    { ...ctx.config, egressDnsPort: findFreePorts(1).take() },
    { ...ctx.deps, vms: ctx.vmm.startGeneration() },
  );

  ctx.stack.defer(() => restarted.broker.stop());

  ctx.stack.defer(() => {
    restarted.egress.stop();
    restarted.diskUsage.stop();
  });

  const agent: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: (request) => restarted.api.app.handle(request),
    }),
  );

  const identity = await agent.tokens.whoami();

  expect(identity).toStrictEqual({
    kind: 'token',
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh', 'npm'],
  });
});

test('it refuses in the transaction a grant checked before an update took its secret off', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-119-1' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh', 'npm'],
  });

  const agent: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  ctx.gap.once = async () => {
    await ctx.client.tokens.update({ name: 'agent', grantable: ['npm'] });
  };

  const added = agent.grants.add({ name: 'dev-a', secret: 'gh' });

  expect(added).rejects.toMatchObject({ code: 'FORBIDDEN', data: { reason: 'not_grantable' } });

  const devAGrants = await ctx.client.grants.list({ name: 'dev-a' });

  expect(devAGrants).toStrictEqual([]);
});

test.each([
  ['a host-wide token', 'BAD_REQUEST', 'admin', ['gh']],
  ['a token without manage', 'BAD_REQUEST', 'runner', ['gh']],
  ['a secret that does not exist', 'NOT_FOUND', 'agent', ['nope']],
  ['a token that does not exist', 'NOT_FOUND', 'nobody', []],
  ['a list that names a secret twice', 'BAD_REQUEST', 'agent', ['gh', 'gh']],
  ['the root token', 'NOT_FOUND', 'root', []],
])('it refuses an update of %s with %s', async (_label, code, name, grantable) => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });

  await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  await ctx.client.tokens.create({ name: 'admin', scope: 'manage' });
  await ctx.client.tokens.create({ name: 'runner', scope: 'exec', imps: ['dev-*'] });

  expect(ctx.client.tokens.update({ name, grantable })).rejects.toMatchObject({ code });
});

test('it clears the list with an empty update', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-119-0' });

  await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  const cleared = await ctx.client.tokens.update({ name: 'agent', grantable: [] });
  const records = await listTokenRecords(ctx.db);

  expect(cleared.grantable).toStrictEqual([]);
  expect(records.find((record) => record.name === 'agent')?.grantable).toStrictEqual([]);
});
