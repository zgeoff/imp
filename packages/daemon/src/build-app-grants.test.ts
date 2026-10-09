import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImpSchema } from '@imp/api';
import type { ImpContract } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { utils } from 'ssh2';
import { checkAccess, findAccess } from './auth/access-policy';
import { loadConfig } from './config';
import { createImpd } from './create-impd';
import type { ImpdDeps } from './create-impd';
import { listApiCalls } from './db/api-audit';
import { createImage } from './db/images';
import { findImpByName } from './db/imps';
import { openDatabase } from './db/open-database';
import { createForkGrants } from './db/secrets';
import { listTokenRecords } from './db/tokens';
import { createEd25519Key } from './ssh/host-key';
import { buildSystemDrivePath, buildSystemDrivesDir } from './storage/data-layout';
import { createXfsBackend } from './storage/xfs-backend';
import { buildStubCpuCgroups } from './test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from './test-utils/build-stub-vmm';
import { findFreePorts } from './test-utils/find-free-ports';

// Scoped tokens that may grant selected secrets (docs/guides/tokens.md#granting-secrets),
// through the API as a client calls it.

// impd's real app on stub VMs with its log lines and RPC failures; `gap.once`
// runs in the next grant write or fork copy, between the access check and
// the transaction
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'build-app-grants-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the stub VMM runs no jailer and builds no boot template; the resolver
  // binds its port on every address, so each impd takes a free one; a new
  // disk stays the size of its image, since a fork copies every byte
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

  const vmm = buildStubVmm();
  const logs: string[] = [];
  const rpcFailures: string[] = [];
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
    log: (line) => {
      logs.push(line);
    },
    logRpcFailure: (failure) => {
      rpcFailures.push(Bun.inspect(failure));
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

  return { db, config, deps, vmm, stack, impd, client, sendToImpd, logs, rpcFailures, gap };
}

test('it lets a token grant a listed secret on its imps', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

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

  await agent.grants.add({ name: 'dev-a', secret: 'gh' });

  const devAGrants = await ctx.client.grants.list({ name: 'dev-a' });

  expect(devAGrants).toStrictEqual(['gh']);
});

test.each([
  ['an unlisted secret on its imp', 'dev-a', 'npm', 'not_grantable'],
  ['a listed secret on another imp', 'prod', 'gh', 'imp_out_of_scope'],
  ['an unlisted secret on another imp', 'prod', 'npm', 'imp_out_of_scope'],
])('it refuses a token’s grant of %s', async (_label, name, secret, reason) => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });

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

  expect(agent.grants.add({ name, secret })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason },
  });

  const grants = await ctx.client.grants.list({ name });

  expect(grants).toStrictEqual([]);
});

test('it lets a token revoke a listed secret on its imps', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });

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

  await agent.grants.delete({ name: 'dev-a', secret: 'gh' });

  const devAGrants = await ctx.client.grants.list({ name: 'dev-a' });

  expect(devAGrants).toStrictEqual([]);
});

test.each([
  ['an unlisted secret on its imp', 'dev-a', 'npm', 'not_grantable'],
  ['a listed secret on another imp', 'prod', 'gh', 'imp_out_of_scope'],
  ['an unlisted secret on another imp', 'prod', 'npm', 'imp_out_of_scope'],
])(
  'it refuses a token’s revoke of %s and keeps the grant',
  async (_label, name, secret, reason) => {
    const ctx = await setupTest();

    await ctx.client.imps.create({ name: 'dev-a' });
    await ctx.client.imps.create({ name: 'prod' });
    await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
    await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });

    // the root token grants everything, so each revoke finds a grant
    await ctx.client.grants.add({ name, secret });

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

    expect(agent.grants.delete({ name, secret })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      data: { reason },
    });

    const kept = await ctx.client.grants.list({ name });

    expect(kept).toStrictEqual([secret]);
  },
);

test('it lets a token list every grant on its imp, listed or not', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'npm' });

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

  const listed = await agent.grants.list({ name: 'dev-a' });

  expect(listed).toStrictEqual(['gh', 'npm']);
});

// checked before any lookup: an unknown secret is refused, not missing
test.each([
  [
    'a token without manage',
    { scope: 'exec' as const, imps: ['dev-*'] },
    'gh',
    { code: 'FORBIDDEN', data: { reason: 'scope' } },
  ],
  [
    'a token without a list',
    { scope: 'manage' as const, imps: ['dev-*'] },
    'gh',
    { code: 'FORBIDDEN', data: { reason: 'not_grantable' } },
  ],
  [
    'a secret that does not exist',
    { scope: 'manage' as const, imps: ['dev-*'], grantable: ['gh'] },
    'nope',
    { code: 'FORBIDDEN', data: { reason: 'not_grantable' } },
  ],
  [
    'a secret that is not a name',
    { scope: 'manage' as const, imps: ['dev-*'], grantable: ['gh'] },
    'Not A Name',
    { code: 'FORBIDDEN', data: { reason: 'not_grantable' } },
  ],
])('it refuses a grant by %s', async (_label, options, secret, refusal) => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

  const made = await ctx.client.tokens.create({ name: 'caller', ...options });

  const caller: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  expect(caller.grants.add({ name: 'dev-a', secret })).rejects.toMatchObject(refusal);
});

test('it refuses a token’s revoke of a secret that does not exist', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

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

  expect(agent.grants.delete({ name: 'dev-a', secret: 'nope' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'not_grantable' },
  });
});

test('it answers NOT_FOUND to a token’s grant on an imp of its patterns that does not exist', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

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

  expect(agent.grants.add({ name: 'dev-gone', secret: 'gh' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

test('it answers NOT_FOUND to a token’s revoke of a grant that does not exist', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

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

  expect(agent.grants.delete({ name: 'dev-a', secret: 'gh' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

test.each([
  [
    'a list without manage',
    { scope: 'exec' as const, imps: ['dev-*'], grantable: ['gh'] },
    'BAD_REQUEST',
  ],
  ['a list without imps', { scope: 'manage' as const, grantable: ['gh'] }, 'BAD_REQUEST'],
  ['an empty list', { scope: 'manage' as const, imps: ['dev-*'], grantable: [] }, 'BAD_REQUEST'],
  [
    'a list that names a secret twice',
    { scope: 'manage' as const, imps: ['dev-*'], grantable: ['gh', 'gh'] },
    'BAD_REQUEST',
  ],
  [
    'a list entry that is not a name',
    { scope: 'manage' as const, imps: ['dev-*'], grantable: ['Not A Name'] },
    'BAD_REQUEST',
  ],
  [
    'a list of 33 secrets',
    {
      scope: 'manage' as const,
      imps: ['dev-*'],
      grantable: Array.from({ length: 33 }, (_, index) => `s${String(index)}`),
    },
    'BAD_REQUEST',
  ],
  [
    'a list entry that does not exist',
    { scope: 'manage' as const, imps: ['dev-*'], grantable: ['gh', 'nope'] },
    'NOT_FOUND',
  ],
])('it refuses a token made with %s and makes no token', async (_label, options, code) => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

  expect(ctx.client.tokens.create({ name: 'agent', ...options })).rejects.toMatchObject({ code });

  const tokens = await ctx.client.tokens.list();

  expect(tokens).toStrictEqual([]);
});

test('it makes a manage token for some imps with a list of secrets that exist', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh', 'npm'],
  });

  expect(made.token.grantable).toStrictEqual(['gh', 'npm']);
});

test('it names the list to the token that holds it', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });

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

  const identity = await agent.tokens.whoami();

  expect(identity).toStrictEqual({
    kind: 'token',
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh', 'npm'],
  });
});

test('it lets the token’s dashboard session grant a listed secret on its imps', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  // the token's session, as a browser on impd's page sends it
  const login = await ctx.sendToImpd(
    new Request('http://impd.test/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token: made.secret }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie);

  const browser: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
      fetch: ctx.sendToImpd,
    }),
  );

  await browser.grants.add({ name: 'dev-a', secret: 'gh' });

  const devAGrants = await ctx.client.grants.list({ name: 'dev-a' });

  expect(devAGrants).toStrictEqual(['gh']);
});

test.each([
  ['an unlisted secret on its imp', 'dev-a', 'npm', 'not_grantable'],
  ['a listed secret on another imp', 'prod', 'gh', 'imp_out_of_scope'],
])(
  'it refuses the token’s dashboard session a grant of %s',
  async (_label, name, secret, reason) => {
    const ctx = await setupTest();

    await ctx.client.imps.create({ name: 'dev-a' });
    await ctx.client.imps.create({ name: 'prod' });
    await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
    await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });

    const made = await ctx.client.tokens.create({
      name: 'agent',
      scope: 'manage',
      imps: ['dev-*'],
      grantable: ['gh'],
    });

    // the token's session, as a browser on impd's page sends it
    const login = await ctx.sendToImpd(
      new Request('http://impd.test/auth/login', {
        method: 'POST',
        headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
        body: JSON.stringify({ token: made.secret }),
      }),
    );

    const cookie = login.headers.get('set-cookie')?.split(';')[0];

    invariant(cookie);

    const browser: ContractRouterClient<ImpContract> = createORPCClient(
      new RPCLink({
        url: 'http://impd.test/rpc',
        headers: { cookie, 'sec-fetch-site': 'same-origin' },
        fetch: ctx.sendToImpd,
      }),
    );

    expect(browser.grants.add({ name, secret })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      data: { reason },
    });
  },
);

test('it refuses the token’s dashboard session a fork', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  // the token's session, as a browser on impd's page sends it
  const login = await ctx.sendToImpd(
    new Request('http://impd.test/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token: made.secret }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie);

  const browser: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
      fetch: ctx.sendToImpd,
    }),
  );

  expect(browser.imps.fork({ source: 'dev-a', name: 'dev-b' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: undefined,
  });
});

test('it names the token’s list to its dashboard session', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  // the token's session, as a browser on impd's page sends it
  const login = await ctx.sendToImpd(
    new Request('http://impd.test/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token: made.secret }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie);

  const browser: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
      fetch: ctx.sendToImpd,
    }),
  );

  const identity = await browser.tokens.whoami();

  expect(identity.grantable).toStrictEqual(['gh']);
});

test('it refuses a fork by a token that may grant and makes no imp', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

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

  expect(agent.imps.fork({ source: 'dev-a', name: 'dev-b' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: undefined,
  });

  const imps = await ctx.client.imps.list();

  expect(imps.map((imp) => imp.name)).toStrictEqual(['dev-a']);
});

test('it refuses a move prepare by a token that may grant and makes no ticket', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

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

  expect(agent.moves.prepare({ name: 'dev-a' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: undefined,
  });

  const tickets = await ctx.db.selectFrom('move_tickets').selectAll().execute();

  expect(tickets).toStrictEqual([]);
});

test('it refuses a move send by a token that may grant', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

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

  expect(
    agent.moves.send({ name: 'dev-a', to: 'https://other.example.com', ticket: 't' }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN', data: undefined });

  const imp = await ctx.client.imps.get({ name: 'dev-a' });

  expect(imp.state).toBe('running');
});

test('it refuses a move resume by a token that may grant', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

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

  expect(agent.moves.resume({ name: 'dev-a' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: undefined,
  });
});

test('it forks for the same patterns without a list, copying no grant it could not make', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'npm' });

  const made = await ctx.client.tokens.create({ name: 'plain', scope: 'manage', imps: ['dev-*'] });

  const plain: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  const fork = await plain.imps.fork({ source: 'dev-a', name: 'dev-b' });

  expect(fork.grantsNotCopied).toStrictEqual([{ secret: 'npm', reason: 'not-grantable' }]);

  const devBGrants = await ctx.client.grants.list({ name: 'dev-b' });

  expect(devBGrants).toStrictEqual([]);
});

test('it refuses a grant of a listed secret that was deleted', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  await ctx.client.secrets.delete({ name: 'gh' });

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

// made again under the name, by the host: another secret
test('it refuses a grant of a listed secret that was deleted and made again', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  await ctx.client.secrets.delete({ name: 'gh' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

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

test('it refuses the dashboard session a grant of a listed secret deleted and made again', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  // the token's session, as a browser on impd's page sends it, made before
  // the secret goes
  const login = await ctx.sendToImpd(
    new Request('http://impd.test/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token: made.secret }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie);

  await ctx.client.secrets.delete({ name: 'gh' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

  const browser: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
      fetch: ctx.sendToImpd,
    }),
  );

  expect(browser.grants.add({ name: 'dev-a', secret: 'gh' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'not_grantable' },
  });
});

test('it refuses a revoke of a listed secret deleted and made again', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  await ctx.client.secrets.delete({ name: 'gh' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });

  const agent: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  expect(agent.grants.delete({ name: 'dev-a', secret: 'gh' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'not_grantable' },
  });

  const devAGrants = await ctx.client.grants.list({ name: 'dev-a' });

  expect(devAGrants).toStrictEqual(['gh']);
});

test('it refuses a grant of a deleted listed secret after a restart', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  await ctx.client.secrets.delete({ name: 'gh' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

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

  expect(agent.grants.add({ name: 'dev-a', secret: 'gh' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'not_grantable' },
  });
});

test('it refuses a fork by a token whose listed secret was deleted, after a restart', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  await ctx.client.secrets.delete({ name: 'gh' });

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

  expect(agent.imps.fork({ source: 'dev-a', name: 'dev-b' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: undefined,
  });
});

test('it still names a deleted listed secret in the list after a restart', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  await ctx.client.secrets.delete({ name: 'gh' });

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

  expect(identity.grantable).toStrictEqual(['gh']);
});

test('it keeps a token’s grants through a sleep', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });

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

  await agent.grants.add({ name: 'dev-a', secret: 'gh' });
  await agent.grants.add({ name: 'dev-a', secret: 'npm' });
  await agent.imps.sleep({ name: 'dev-a' });

  const listed = await agent.grants.list({ name: 'dev-a' });

  expect(listed).toStrictEqual(['gh', 'npm']);
});

test('it keeps a token’s grants through a wake', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });

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

  await agent.grants.add({ name: 'dev-a', secret: 'gh' });
  await agent.grants.add({ name: 'dev-a', secret: 'npm' });
  await agent.imps.sleep({ name: 'dev-a' });
  await agent.imps.wake({ name: 'dev-a' });

  const listed = await agent.grants.list({ name: 'dev-a' });

  expect(listed).toStrictEqual(['gh', 'npm']);
});

// a restore brings back the disk, not the grants of that time
test('it keeps a token’s grants as they are now through a checkpoint restore', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });

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

  await agent.grants.add({ name: 'dev-a', secret: 'gh' });
  await agent.grants.add({ name: 'dev-a', secret: 'npm' });

  const checkpoint = await agent.checkpoints.create({ name: 'dev-a' });

  await agent.grants.delete({ name: 'dev-a', secret: 'npm' });
  await agent.checkpoints.restore({ name: 'dev-a', checkpoint: checkpoint.id });

  const listed = await agent.grants.list({ name: 'dev-a' });

  expect(listed).toStrictEqual(['gh']);
});

test('it keeps a token’s grants through a restart', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });

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

  await agent.grants.add({ name: 'dev-a', secret: 'gh' });
  await agent.grants.add({ name: 'dev-a', secret: 'npm' });

  const restarted = await createImpd(
    { ...ctx.config, egressDnsPort: findFreePorts(1).take() },
    { ...ctx.deps, vms: ctx.vmm.startGeneration() },
  );

  ctx.stack.defer(() => restarted.broker.stop());

  ctx.stack.defer(() => {
    restarted.egress.stop();
    restarted.diskUsage.stop();
  });

  const after: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: (request) => restarted.api.app.handle(request),
    }),
  );

  const listed = await after.grants.list({ name: 'dev-a' });

  expect(listed).toStrictEqual(['gh', 'npm']);
});

test('it gives an imp made from a template no grants', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

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

  await agent.grants.add({ name: 'dev-a', secret: 'gh' });
  await ctx.client.images.add({ imp: 'dev-a', name: 'dev-tpl' });
  await agent.imps.create({ name: 'dev-c', image: 'dev-tpl' });

  const listed = await agent.grants.list({ name: 'dev-c' });

  expect(listed).toStrictEqual([]);
});

test('it takes a destroyed imp’s grants with it', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

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

  await agent.grants.add({ name: 'dev-a', secret: 'gh' });
  await agent.imps.destroy({ name: 'dev-a' });
  await agent.imps.create({ name: 'dev-a' });

  const listed = await agent.grants.list({ name: 'dev-a' });

  expect(listed).toStrictEqual([]);
});

test('it puts no secret value in an answer, error, log line or audit row', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'prod' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });

  await ctx.client.secrets.add({
    name: 'gh-api',
    kind: 'custom',
    value: 'sk-synthetic-126-2',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
  });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh', 'gh-api'],
  });

  const agent: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  // gh first, so gh-api clashes with it on api.github.com
  const granted = await Promise.allSettled([agent.grants.add({ name: 'dev-a', secret: 'gh' })]);

  const answers = await Promise.allSettled([
    agent.grants.add({ name: 'dev-a', secret: 'gh-api' }),
    agent.grants.add({ name: 'dev-a', secret: 'npm' }),
    agent.grants.add({ name: 'prod', secret: 'gh' }),
    agent.imps.fork({ source: 'dev-a', name: 'dev-b' }),
    agent.grants.list({ name: 'dev-a' }),
    agent.secrets.list(),
    agent.tokens.whoami(),
    ctx.client.tokens.list(),
  ]);

  const last = await Promise.allSettled([
    ctx.client.secrets.add({
      name: 'gh-api',
      kind: 'github',
      value: 'sk-synthetic-126-3',
      replace: true,
    }),
    agent.grants.delete({ name: 'dev-a', secret: 'gh' }),
  ]);

  const calls = await listApiCalls(ctx.db, null, 100, null);
  const brokerRows = await ctx.db.selectFrom('broker_audit').selectAll().execute();

  const everything = JSON.stringify([
    made.token,
    granted,
    answers,
    last,
    ctx.rpcFailures,
    ctx.logs,
    calls,
    brokerRows,
  ]);

  // the refusals and the clash are there, by name
  expect(calls.map((call) => call.outcome)).toContain('FORBIDDEN');
  expect(calls.map((call) => call.outcome)).toContain('CONFLICT');
  expect(everything).toContain('gh-api');
  expect(everything).not.toContain('sk-synthetic-126');
});

test('it refuses in the transaction a grant whose secret was deleted and made again after the check', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

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

  ctx.gap.once = async () => {
    await ctx.client.secrets.delete({ name: 'gh' });
    await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  };

  expect(agent.grants.add({ name: 'dev-a', secret: 'gh' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'not_grantable' },
  });

  const devAGrants = await ctx.client.grants.list({ name: 'dev-a' });

  expect(devAGrants).toStrictEqual([]);
});

test('it makes no grant for a token removed after the access check', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'npm' });

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

  ctx.gap.once = async () => {
    await ctx.client.tokens.delete({ name: 'agent' });
  };

  expect(agent.grants.add({ name: 'dev-a', secret: 'gh' })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });

  const devAGrants = await ctx.client.grants.list({ name: 'dev-a' });

  expect(devAGrants).toStrictEqual(['npm']);
});

test('it revokes no grant for a token removed after the access check', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });

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

  ctx.gap.once = async () => {
    await ctx.client.tokens.delete({ name: 'agent' });
  };

  expect(agent.grants.delete({ name: 'dev-a', secret: 'gh' })).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });

  const devAGrants = await ctx.client.grants.list({ name: 'dev-a' });

  expect(devAGrants).toStrictEqual(['gh']);
});

test('it drops the grant a rebind left stale', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });

  const rebound = await ctx.client.secrets.add({
    name: 'gh',
    kind: 'custom',
    value: 'sk-synthetic-126-0',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    replace: true,
    rebind: true,
  });

  expect(rebound.droppedGrants).toBe(1);
});

test('it refuses a grant by a list entry from before a rebind', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  await ctx.client.secrets.add({
    name: 'gh',
    kind: 'custom',
    value: 'sk-synthetic-126-0',
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

test('it refuses a revoke by a list entry from before a rebind', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  await ctx.client.secrets.add({
    name: 'gh',
    kind: 'custom',
    value: 'sk-synthetic-126-0',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    replace: true,
    rebind: true,
  });

  // granted again at the new generation, so a revoke finds a grant
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });

  const agent: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  expect(agent.grants.delete({ name: 'dev-a', secret: 'gh' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'not_grantable' },
  });
});

test('it keeps an unchanged grant usable through sleep, wake and a checkpoint restore', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'npm' });

  const checkpoint = await ctx.client.checkpoints.create({ name: 'dev-a' });

  await ctx.client.imps.sleep({ name: 'dev-a' });
  await ctx.client.imps.wake({ name: 'dev-a' });
  await ctx.client.checkpoints.restore({ name: 'dev-a', checkpoint: checkpoint.id });

  const imp = await findImpByName(ctx.db, 'dev-a');

  invariant(imp);

  const granted = await ctx.impd.broker.isGranted(imp.id, 'registry.npmjs.org');

  expect(granted).toBeTrue();
});

test('it keeps a revoke made after the checkpoint through its restore', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });

  const checkpoint = await ctx.client.checkpoints.create({ name: 'dev-a' });

  await ctx.client.grants.delete({ name: 'dev-a', secret: 'gh' });
  await ctx.client.checkpoints.restore({ name: 'dev-a', checkpoint: checkpoint.id });

  const imp = await findImpByName(ctx.db, 'dev-a');

  invariant(imp);

  const granted = await ctx.impd.broker.isGranted(imp.id, 'api.github.com');

  expect(granted).toBeFalse();
});

test('it keeps a rebind made after the checkpoint through its restore', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'npm' });

  const checkpoint = await ctx.client.checkpoints.create({ name: 'dev-a' });

  await ctx.client.secrets.add({
    name: 'npm',
    kind: 'custom',
    value: 'sk-synthetic-126-1',
    rules: [{ host: 'registry.npmjs.org', header: 'x-token', scheme: 'raw' }],
    replace: true,
    rebind: true,
  });

  await ctx.client.checkpoints.restore({ name: 'dev-a', checkpoint: checkpoint.id });

  const imp = await findImpByName(ctx.db, 'dev-a');

  invariant(imp);

  const granted = await ctx.impd.broker.isGranted(imp.id, 'registry.npmjs.org');

  expect(granted).toBeFalse();
});

test('it refuses a backup restore by a token that may grant, before anything happens', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

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

  expect(agent.backups.restore({ name: 'dev-a', as: 'dev-b' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: undefined,
  });

  const imps = await ctx.client.imps.list();

  expect(imps.map((imp) => imp.name)).toStrictEqual(['dev-a']);
});

test.each([['imps.fork'], ['moves.prepare'], ['moves.send'], ['moves.resume']])(
  'it refuses %s to an ssh key of a token that may grant, with every entry stale',
  async (path) => {
    const ctx = await setupTest();

    await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

    const key = createEd25519Key().public;
    const parsed = utils.parseKey(key);

    if (parsed instanceof Error) {
      throw parsed;
    }

    await ctx.client.tokens.create({
      name: 'agent',
      scope: 'manage',
      imps: ['dev-*'],
      grantable: ['gh'],
      sshKeys: [key],
    });

    // every entry stale
    await ctx.client.secrets.delete({ name: 'gh' });

    const caller = ctx.impd.tokens.findSshKey(parsed.getPublicSSH())?.caller;

    invariant(caller);

    const refusal = await checkAccess(
      findAccess(path),
      caller,
      { source: 'dev-a', name: 'dev-a' },
      () => Promise.resolve(null),
    );

    expect(caller.kind).toBe('ssh');
    expect(refusal?.message).toInclude('may not fork');
  },
);

test('it refuses a move prepare to the dashboard session of a token whose entries are all stale', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  // every entry stale
  await ctx.client.secrets.delete({ name: 'gh' });

  // the token's session, as a browser on impd's page sends it
  const login = await ctx.sendToImpd(
    new Request('http://impd.test/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token: made.secret }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie);

  const browser: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
      fetch: ctx.sendToImpd,
    }),
  );

  expect(browser.moves.prepare({ name: 'dev-a' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: undefined,
  });
});

test('it refuses a fork to the dashboard session of a token whose entries are all stale', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });

  const made = await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  // every entry stale
  await ctx.client.secrets.delete({ name: 'gh' });

  // the token's session, as a browser on impd's page sends it
  const login = await ctx.sendToImpd(
    new Request('http://impd.test/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token: made.secret }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie);

  const browser: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { cookie, 'sec-fetch-site': 'same-origin' },
      fetch: ctx.sendToImpd,
    }),
  );

  expect(browser.imps.fork({ source: 'dev-a', name: 'dev-b' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: undefined,
  });
});

// A fork copies its source's grants only as far as the caller could make
// them (docs/guides/connectors.md#secrets-and-grants): every one for a
// host-wide caller, none it could not grant for a caller with patterns.

test.each([
  ['live', { source: 'dev-a', name: 'dev-b' }],
  ['from a checkpoint', { source: 'dev-a', name: 'dev-b', checkpoint: 'cp' }],
])('it copies every grant to a root token’s fork, %s', async (_label, input) => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'npm' });
  await ctx.client.checkpoints.create({ name: 'dev-a', label: 'cp' });

  const fork = await ctx.client.imps.fork(input);

  expect(fork.grantsNotCopied).toStrictEqual([]);
  expect(fork.grantsError).toBeUndefined();

  const devBGrants = await ctx.client.grants.list({ name: 'dev-b' });

  expect(devBGrants).toStrictEqual(['gh', 'npm']);
});

test.each([
  ['live', { source: 'dev-a', name: 'dev-b' }],
  ['from a checkpoint', { source: 'dev-a', name: 'dev-b', checkpoint: 'cp' }],
])('it copies every grant to a host-wide manage token’s fork, %s', async (_label, input) => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'npm' });
  await ctx.client.checkpoints.create({ name: 'dev-a', label: 'cp' });

  const made = await ctx.client.tokens.create({ name: 'host', scope: 'manage' });

  const host: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  const fork = await host.imps.fork(input);

  expect(fork.grantsNotCopied).toStrictEqual([]);
  expect(fork.grantsError).toBeUndefined();

  const devBGrants = await ctx.client.grants.list({ name: 'dev-b' });

  expect(devBGrants).toStrictEqual(['gh', 'npm']);
});

test.each([
  ['live', { source: 'dev-a', name: 'dev-b' }],
  ['from a checkpoint', { source: 'dev-a', name: 'dev-b', checkpoint: 'cp' }],
])('it copies no grant to a scoped token’s fork and names each, %s', async (_label, input) => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'npm' });
  await ctx.client.checkpoints.create({ name: 'dev-a', label: 'cp' });

  const made = await ctx.client.tokens.create({ name: 'scoped', scope: 'manage', imps: ['dev-*'] });

  const scoped: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  const fork = await scoped.imps.fork(input);

  expect(fork.grantsNotCopied).toStrictEqual([
    { secret: 'gh', reason: 'not-grantable' },
    { secret: 'npm', reason: 'not-grantable' },
  ]);

  expect(fork.grantsError).toBeUndefined();

  const devBGrants = await ctx.client.grants.list({ name: 'dev-b' });

  expect(devBGrants).toStrictEqual([]);
});

test('it names a grant made on the fork before the copy as a clash', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });

  await ctx.client.secrets.add({
    name: 'gh-api',
    kind: 'custom',
    value: 'sk-synthetic-126-2',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
  });

  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'npm' });

  // the fork exists by then, so a host-wide grant on it lands first
  ctx.gap.once = async () => {
    await ctx.client.grants.add({ name: 'dev-b', secret: 'gh-api' });
  };

  const fork = await ctx.client.imps.fork({ source: 'dev-a', name: 'dev-b' });

  expect(fork.grantsNotCopied).toStrictEqual([{ secret: 'gh', reason: 'clash' }]);

  const devBGrants = await ctx.client.grants.list({ name: 'dev-b' });

  expect(devBGrants).toStrictEqual(['gh-api', 'npm']);

  expect(ctx.logs).toContain(
    'impd: dev-b: forked without grant gh of dev-a: it has another credential for that host',
  );
});

test('it copies the grants a rebind between the fork and the copy left', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'npm' });

  // the rebind drops every grant of gh, the source's too
  ctx.gap.once = async () => {
    await ctx.client.secrets.add({
      name: 'gh',
      kind: 'custom',
      value: 'sk-synthetic-126-0',
      rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
      replace: true,
      rebind: true,
    });
  };

  const fork = await ctx.client.imps.fork({ source: 'dev-a', name: 'dev-b' });

  expect(fork.grantsNotCopied).toStrictEqual([]);

  const devBGrants = await ctx.client.grants.list({ name: 'dev-b' });

  expect(devBGrants).toStrictEqual(['npm']);
});

test('it lends the fork nothing from a source destroyed and made again before the copy', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });

  // the new dev-a holds npm: a copy by name would hand it to the fork
  ctx.gap.once = async () => {
    await ctx.client.imps.destroy({ name: 'dev-a' });
    await ctx.client.imps.create({ name: 'dev-a' });
    await ctx.client.grants.add({ name: 'dev-a', secret: 'npm' });
  };

  const fork = await ctx.client.imps.fork({ source: 'dev-a', name: 'dev-b' });

  expect(fork.grantsNotCopied).toStrictEqual([]);
  expect(fork.grantsError).toBeUndefined();

  const devBGrants = await ctx.client.grants.list({ name: 'dev-b' });

  expect(devBGrants).toStrictEqual([]);

  const devAGrants = await ctx.client.grants.list({ name: 'dev-a' });

  expect(devAGrants).toStrictEqual(['npm']);
});

test('it keeps the fork’s grant when the source’s is revoked after the fork', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await ctx.client.imps.fork({ source: 'dev-a', name: 'dev-b' });
  await ctx.client.grants.delete({ name: 'dev-a', secret: 'gh' });

  const devAGrants = await ctx.client.grants.list({ name: 'dev-a' });

  expect(devAGrants).toStrictEqual([]);

  const devBGrants = await ctx.client.grants.list({ name: 'dev-b' });

  expect(devBGrants).toStrictEqual(['gh']);
});

test('it returns a fork whose copy fails as a whole, with the error and no grant', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'npm' });

  // the copy writes gh, then fails to read npm: the transaction takes gh back
  await ctx.db
    .updateTable('secrets')
    .set({ rules: 'not json' })
    .where('name', '=', 'npm')
    .execute();

  const fork = await ctx.client.imps.fork({ source: 'dev-a', name: 'dev-b' });

  expect(fork.name).toBe('dev-b');
  expect(fork.grantsNotCopied).toStrictEqual([]);

  expect(fork.grantsError).toBe(
    "the source's grants could not be copied, so the fork has none; impd's log has the cause",
  );

  const devBGrants = await ctx.client.grants.list({ name: 'dev-b' });

  expect(devBGrants).toStrictEqual([]);
  expect(ctx.logs.join('\n')).toInclude('impd: dev-b: forked without the grants of dev-a: ');
});

test('it lets an older client read a fork answer with the new fields', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });

  const made = await ctx.client.tokens.create({ name: 'scoped', scope: 'manage', imps: ['dev-*'] });

  const scoped: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${made.secret}` },
      fetch: ctx.sendToImpd,
    }),
  );

  const fork = await scoped.imps.fork({ source: 'dev-a', name: 'dev-b' });

  // the output schema before the report: a plain object drops the fields
  const parsed = ImpSchema.parse(fork);

  expect(parsed.name).toBe('dev-b');
  expect(parsed).not.toHaveProperty('grantsNotCopied');
});

// The copy's own checks, for a caller whose list is not empty: no such
// caller reaches imps.fork today (it is refused first), so these call the
// copy as the handler would, with the authority read at the access check.

test('it copies to a listed caller’s fork the secrets on its list, and names the rest', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'dev-b' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'npm' });

  await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  const [token] = await listTokenRecords(ctx.db);
  const from = await findImpByName(ctx.db, 'dev-a');
  const to = await findImpByName(ctx.db, 'dev-b');

  invariant(token);
  invariant(from);
  invariant(to);

  const outcome = await createForkGrants(ctx.db, from.id, to.id, {
    tokenId: token.id,
    grantable: token.grantable,
  });

  expect(outcome).toStrictEqual({
    kind: 'copied',
    notCopied: [{ secret: 'npm', reason: 'not-grantable' }],
  });

  const devBGrants = await ctx.client.grants.list({ name: 'dev-b' });

  expect(devBGrants).toStrictEqual(['gh']);
});

test('it copies nothing of a secret whose list entry is from before a rebind', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'dev-b' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'npm' });

  await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  // the authority read at the access check
  const [token] = await listTokenRecords(ctx.db);

  invariant(token);

  // rebound after the access check, and granted again at its new generation
  await ctx.client.secrets.add({
    name: 'gh',
    kind: 'custom',
    value: 'sk-synthetic-126-0',
    rules: [{ host: 'api.github.com', header: 'authorization', scheme: 'bearer' }],
    replace: true,
    rebind: true,
  });

  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });

  const from = await findImpByName(ctx.db, 'dev-a');
  const to = await findImpByName(ctx.db, 'dev-b');

  invariant(from);
  invariant(to);

  const outcome = await createForkGrants(ctx.db, from.id, to.id, {
    tokenId: token.id,
    grantable: token.grantable,
  });

  expect(outcome).toStrictEqual({
    kind: 'copied',
    notCopied: [
      { secret: 'gh', reason: 'not-grantable' },
      { secret: 'npm', reason: 'not-grantable' },
    ],
  });

  const devBGrants = await ctx.client.grants.list({ name: 'dev-b' });

  expect(devBGrants).toStrictEqual([]);
});

test('it copies no grant for a token removed after the access check', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'dev-b' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });

  await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  // the authority read at the access check
  const [token] = await listTokenRecords(ctx.db);

  invariant(token);

  await ctx.client.tokens.delete({ name: 'agent' });

  const from = await findImpByName(ctx.db, 'dev-a');
  const to = await findImpByName(ctx.db, 'dev-b');

  invariant(from);
  invariant(to);

  const outcome = await createForkGrants(ctx.db, from.id, to.id, {
    tokenId: token.id,
    grantable: token.grantable,
  });

  expect(outcome).toStrictEqual({ kind: 'no-token' });

  const devBGrants = await ctx.client.grants.list({ name: 'dev-b' });

  expect(devBGrants).toStrictEqual([]);
});

test('it copies nothing of a secret taken off the list after the access check', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-a' });
  await ctx.client.imps.create({ name: 'dev-b' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-126-0' });
  await ctx.client.secrets.add({ name: 'npm', kind: 'npm', value: 'sk-synthetic-126-1' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'npm' });

  await ctx.client.tokens.create({
    name: 'agent',
    scope: 'manage',
    imps: ['dev-*'],
    grantable: ['gh'],
  });

  // the authority read at the access check
  const [token] = await listTokenRecords(ctx.db);

  invariant(token);

  // the update drops gh from dev-a; the root token grants it again
  await ctx.client.tokens.update({ name: 'agent', grantable: ['npm'] });
  await ctx.client.grants.add({ name: 'dev-a', secret: 'gh' });

  const from = await findImpByName(ctx.db, 'dev-a');
  const to = await findImpByName(ctx.db, 'dev-b');

  invariant(from);
  invariant(to);

  const outcome = await createForkGrants(ctx.db, from.id, to.id, {
    tokenId: token.id,
    grantable: token.grantable,
  });

  expect(outcome).toStrictEqual({
    kind: 'copied',
    notCopied: [
      { secret: 'gh', reason: 'not-grantable' },
      { secret: 'npm', reason: 'not-grantable' },
    ],
  });

  const devBGrants = await ctx.client.grants.list({ name: 'dev-b' });

  expect(devBGrants).toStrictEqual([]);
});
