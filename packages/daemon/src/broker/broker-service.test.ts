import { expect, onTestFinished, test } from 'bun:test';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as connectTls } from 'node:tls';
import type { ImpContract } from '@imp/api';
import { buildMockBrokerRule } from '@imp/api/test-utils/build-mock-broker-rule';
import { invariant } from '@imp/test-utils/invariant';
import { server } from '@imp/test-utils/mock-server';
import { waitFor } from '@imp/test-utils/wait-for';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { sql } from 'kysely';
import { HttpResponse, http } from 'msw';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { AUDIT_ROWS_PER_IMP, listAuditEntries, writeAuditEntry } from '../db/broker-audit';
import { createImage } from '../db/images';
import { findImpByName, updateImpMove } from '../db/imps';
import { openDatabase } from '../db/open-database';
import { findSecret } from '../db/secrets';
import { parsePrefix64 } from '../net/addressing6';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { startStubBrokerGuestSocket } from '../test-utils/start-stub-broker-guest-socket';
import { startStubBrokerReplyTarget } from '../test-utils/start-stub-broker-reply-target';
import { createBroker } from './broker-service';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'broker-service-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // no jailer, no boot template; a loopback subnet lets a test's socket be
  // a guest; each resolver takes a free port; a new disk stays the size of
  // its image, so a fork's copy fits in /tmp
  const config = {
    ...loadConfig({
      IMP_DATA_DIR: dataDir,
      IMP_JAILER: 'false',
      IMP_BOOT_TEMPLATES: 'false',
      IMP_SUBNET: '127.0.0.0/16',
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
  const logs: string[] = [];
  const installs: string[] = [];

  // the API's unexpected RPC failures, as it would log them
  const rpcFailures: unknown[] = [];

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
    log: (message) => {
      logs.push(message);
    },
    logRpcFailure: (failure) => {
      rpcFailures.push(failure);
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
      // the guest's CA install, which takes where the vsock path exists
      installBundle: (vsockPath) => {
        installs.push(vsockPath);

        return access(vsockPath);
      },
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

  return { stack, config, db, dataDir, logs, rpcFailures, installs, impd, client };
}

test('it stores a secret value in an owner-only file the row names', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  const secret = await findSecret(ctx.db, 'gh');

  invariant(secret);

  const path = join(ctx.dataDir, 'secrets', secret.valueFile);

  const value = await readFile(path, 'utf8');
  const stats = await stat(path);

  expect(value).toBe('ghp_SECRETVALUE0123456789');
  expect(stats.mode & 0o777).toBe(0o600);
});

test('it answers an added secret with its hosts and no value', async () => {
  const ctx = await setupTest();

  const added: unknown = await ctx.client.secrets.add({
    name: 'gh',
    kind: 'github',
    value: 'ghp_SECRETVALUE0123456789',
  });

  expect(added).toStrictEqual({
    name: 'gh',
    kind: 'github',
    rules: [
      { host: 'github.com', header: 'authorization', scheme: 'basic', user: 'x-access-token' },
      { host: 'api.github.com', header: 'authorization', scheme: 'bearer' },
      { host: 'uploads.github.com', header: 'authorization', scheme: 'bearer' },
    ],
    imps: [],
    createdAt: expect.any(Date) as unknown,
    droppedGrants: 0,
  });
});

test('it never shows a granted value through the API', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const everything = JSON.stringify([
    await ctx.client.secrets.list(),
    await ctx.client.grants.list({ name: 'dev' }),
    await ctx.client.imps.list(),
    await ctx.client.imps.get({ name: 'dev' }),
    await ctx.client.system.info(),
  ]);

  expect(everything).not.toInclude('ghp_SECRETVALUE0123456789');
});

test('it lists a secret with the imps it is granted to', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const secrets: unknown = await ctx.client.secrets.list();

  expect(secrets).toStrictEqual([
    {
      name: 'gh',
      kind: 'github',
      rules: [
        { host: 'github.com', header: 'authorization', scheme: 'basic', user: 'x-access-token' },
        { host: 'api.github.com', header: 'authorization', scheme: 'bearer' },
        { host: 'uploads.github.com', header: 'authorization', scheme: 'bearer' },
      ],
      imps: ['dev'],
      createdAt: expect.any(Date) as unknown,
    },
  ]);
});

test.each([['../etc'], ['a/b'], ['.hidden'], ['Upper'], ['']])(
  'it rejects the secret name %p before it reaches the disk',
  async (name) => {
    const ctx = await setupTest();

    expect(
      ctx.client.secrets.add({ name, kind: 'github', value: 'ghp_SECRETVALUE0123456789' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  },
);

test('it rejects a value that could split a header', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'a\r\nx-evil: 1' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it rejects a custom secret without rules', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'ghp_SECRETVALUE0123456789' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it refuses a taken name without replace and keeps the stored value', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  const taken = ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'other' });

  expect(taken).rejects.toMatchObject({ code: 'CONFLICT' });

  const secret = await findSecret(ctx.db, 'gh');

  invariant(secret);

  const value = await readFile(join(ctx.dataDir, 'secrets', secret.valueFile), 'utf8');

  expect(value).toBe('ghp_SECRETVALUE0123456789');
});

test('it writes a replace to a new file and removes the old one', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'rotated', replace: true });

  const secret = await findSecret(ctx.db, 'gh');

  invariant(secret);

  const files = await readdir(join(ctx.dataDir, 'secrets'));
  const value = await readFile(join(ctx.dataDir, 'secrets', secret.valueFile), 'utf8');

  expect(files).toStrictEqual([secret.valueFile]);
  expect(value).toBe('rotated');
});

test('it keeps the value out of the error and the log when its write fails', async () => {
  const ctx = await setupTest();

  // a file where the directory goes: the write fails, even as root
  await rm(join(ctx.dataDir, 'secrets'), { recursive: true });
  await writeFile(join(ctx.dataDir, 'secrets'), '');

  const added = ctx.impd.broker.addSecret({
    name: 'gh',
    kind: 'github',
    value: 'ghp_SECRETVALUE0123456789',
  });

  expect(added).rejects.toSatisfy(
    (thrown: unknown) =>
      thrown instanceof Error &&
      !`${String(thrown)} ${JSON.stringify(thrown)}`.includes('ghp_SECRETVALUE0123456789'),
  );

  expect(ctx.logs.join('\n')).not.toInclude('ghp_SECRETVALUE0123456789');
});

test('it keeps the value out of the API’s error and impd’s log when its write fails', async () => {
  const ctx = await setupTest();

  // a file where the directory goes: the write fails, even as root
  await rm(join(ctx.dataDir, 'secrets'), { recursive: true });
  await writeFile(join(ctx.dataDir, 'secrets'), '');

  const added = ctx.client.secrets.add({
    name: 'gh',
    kind: 'github',
    value: 'ghp_SECRETVALUE0123456789',
  });

  expect(added).rejects.toSatisfy(
    (thrown: unknown) =>
      thrown instanceof Error &&
      !`${String(thrown)} ${JSON.stringify(thrown)}`.includes('ghp_SECRETVALUE0123456789'),
  );

  expect(ctx.logs.join('\n')).not.toInclude('ghp_SECRETVALUE0123456789');
});

test('it logs a failed write in the API’s log without the value', async () => {
  const ctx = await setupTest();

  // a file where the directory goes: the write fails, even as root
  await rm(join(ctx.dataDir, 'secrets'), { recursive: true });
  await writeFile(join(ctx.dataDir, 'secrets'), '');

  const added = ctx.client.secrets.add({
    name: 'gh',
    kind: 'github',
    value: 'ghp_SECRETVALUE0123456789',
  });

  expect(added).rejects.toThrow();

  // as console.error would print each: message, stack and own fields
  const logged = ctx.rpcFailures.map((failure) => Bun.inspect(failure));

  expect(logged).toHaveLength(1);
  expect(logged).toSatisfyAll((line: string) => !line.includes('ghp_SECRETVALUE0123456789'));
});

test('it leaves no row behind when the value cannot be written', async () => {
  const ctx = await setupTest();

  // a file where the directory goes: the write fails, even as root
  await rm(join(ctx.dataDir, 'secrets'), { recursive: true });
  await writeFile(join(ctx.dataDir, 'secrets'), '');

  const added = ctx.impd.broker.addSecret({
    name: 'gh',
    kind: 'github',
    value: 'ghp_SECRETVALUE0123456789',
  });

  expect(added).rejects.toThrow();

  const left = await ctx.client.secrets.list();

  expect(left).toStrictEqual([]);
});

test('it rejects a grant to an imp that does not exist', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  expect(ctx.client.grants.add({ name: 'nope', secret: 'gh' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp' },
  });
});

test('it rejects a grant of a secret that does not exist', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  expect(ctx.client.grants.add({ name: 'dev', secret: 'nope' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'secret' },
  });
});

test('it rejects a second credential for a host the imp already has one for', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  await ctx.client.secrets.add({
    name: 'gh-api',
    kind: 'custom',
    value: 'ghp_SECRETVALUE0123456789',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  expect(ctx.client.grants.add({ name: 'dev', secret: 'gh-api' })).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'secret gh already gives dev a credential for api.github.com',
  });
});

test('it rejects a revoke of a grant that is not there', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  expect(ctx.client.grants.delete({ name: 'dev', secret: 'gh' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'grant' },
  });
});

test('it refuses a revoke on an imp that is moving', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  await updateImpMove(ctx.db, dev.id, 'receiving');

  expect(ctx.impd.broker.removeGrant('dev', 'gh')).rejects.toMatchObject({ code: 'MOVING' });
});

test('it copies the grants of the source to a fork', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  await ctx.client.secrets.add({
    name: 'claude',
    kind: 'anthropic',
    value: 'ghp_SECRETVALUE0123456789',
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev', secret: 'claude' });
  await ctx.client.imps.fork({ source: 'dev', name: 'copy' });

  const copied = await ctx.client.grants.list({ name: 'copy' });

  expect(copied).toStrictEqual(['claude', 'gh']);
});

test('it takes the grants and the value file of a deleted secret along', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  await ctx.client.secrets.add({
    name: 'claude',
    kind: 'anthropic',
    value: 'ghp_SECRETVALUE0123456789',
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev', secret: 'claude' });
  await ctx.client.secrets.delete({ name: 'claude' });

  const grants = await ctx.client.grants.list({ name: 'dev' });
  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(grants).toStrictEqual(['gh']);
  expect(files).toStrictEqual([expect.toStartWith('gh.')]);
});

test('it takes the grants of a destroyed imp along', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.client.imps.destroy({ name: 'dev' });

  const left = await ctx.db.selectFrom('grants').selectAll().execute();

  expect(left).toStrictEqual([]);
});

test('it gives an imp without a grant no broker variables and installs nothing', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const imp = await findImpByName(ctx.db, 'dev');

  invariant(imp);

  const vsock = join(ctx.dataDir, 'vsock');

  await writeFile(vsock, '');

  const env = await ctx.impd.broker.readExecEnv(imp, vsock);

  expect(env).toStrictEqual({ kind: 'ungranted' });
  expect(ctx.installs).toStrictEqual([]);
});

test('it gives a granted imp the broker variables once the CA is in its boot', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const imp = await findImpByName(ctx.db, 'dev');

  invariant(imp);

  const vsock = join(ctx.dataDir, 'vsock');

  await writeFile(vsock, '');

  const env = await ctx.impd.broker.readExecEnv(imp, vsock);

  expect(env).toStrictEqual({
    kind: 'ready',
    env: [
      'HTTPS_PROXY=http://127.0.0.1:7081',
      'https_proxy=http://127.0.0.1:7081',
      'NO_PROXY=localhost,127.0.0.1,::1',
      'no_proxy=localhost,127.0.0.1,::1',
      'NODE_USE_ENV_PROXY=1',
      'SSL_CERT_FILE=/etc/imp/broker-ca.pem',
      'NODE_EXTRA_CA_CERTS=/etc/imp/broker-ca.pem',
      'GIT_SSL_CAINFO=/etc/imp/broker-ca.pem',
      'REQUESTS_CA_BUNDLE=/etc/imp/broker-ca.pem',
      'CURL_CA_BUNDLE=/etc/imp/broker-ca.pem',
      'GH_TOKEN=imp-broker-placeholder',
      'GITHUB_TOKEN=imp-broker-placeholder',
    ],
  });
});

test('it points an imp in another slot at that slot’s gateway', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.create({ name: 'dev-2' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev-2', secret: 'gh' });

  const imp = await findImpByName(ctx.db, 'dev-2');

  invariant(imp);

  const vsock = join(ctx.dataDir, 'vsock');

  await writeFile(vsock, '');

  const env = await ctx.impd.broker.readExecEnv(imp, vsock);

  expect(env).toStrictEqual({
    kind: 'ready',
    env: [
      'HTTPS_PROXY=http://127.0.0.5:7081',
      'https_proxy=http://127.0.0.5:7081',
      'NO_PROXY=localhost,127.0.0.1,::1',
      'no_proxy=localhost,127.0.0.1,::1',
      'NODE_USE_ENV_PROXY=1',
      'SSL_CERT_FILE=/etc/imp/broker-ca.pem',
      'NODE_EXTRA_CA_CERTS=/etc/imp/broker-ca.pem',
      'GIT_SSL_CAINFO=/etc/imp/broker-ca.pem',
      'REQUESTS_CA_BUNDLE=/etc/imp/broker-ca.pem',
      'CURL_CA_BUNDLE=/etc/imp/broker-ca.pem',
      'GH_TOKEN=imp-broker-placeholder',
      'GITHUB_TOKEN=imp-broker-placeholder',
    ],
  });
});

test('it installs the CA once per boot however many execs ask', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const imp = await findImpByName(ctx.db, 'dev');

  invariant(imp);

  const vsock = join(ctx.dataDir, 'vsock');

  await writeFile(vsock, '');

  await ctx.impd.broker.readExecEnv(imp, vsock);
  await ctx.impd.broker.readExecEnv(imp, vsock);

  expect(ctx.installs).toStrictEqual([vsock]);
});

test('it gives a new boot whose install fails no broker variables, and logs why', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const imp = await findImpByName(ctx.db, 'dev');

  invariant(imp?.pid);

  const vsock = join(ctx.dataDir, 'vsock');

  await writeFile(vsock, '');

  await ctx.impd.broker.readExecEnv(imp, vsock);

  // another pid is a new boot, whose guest has no agent socket to install through
  const env = await ctx.impd.broker.readExecEnv(
    { ...imp, pid: imp.pid + 1 },
    join(ctx.dataDir, 'gone'),
  );

  expect(env).toStrictEqual({ kind: 'untrusted', detail: expect.toStartWith('ENOENT') });

  expect(ctx.logs).toContainEqual(
    expect.toStartWith(
      'impd: dev: broker CA not installed, so this exec gets no broker variables: ENOENT',
    ),
  );
});

test('it installs again for the same pid after the imp stops', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const imp = await findImpByName(ctx.db, 'dev');

  invariant(imp);

  const vsock = join(ctx.dataDir, 'vsock');

  await writeFile(vsock, '');

  await ctx.impd.broker.readExecEnv(imp, vsock);
  await ctx.client.imps.stop({ name: 'dev' });

  // the record as it was before the stop: the pid a new boot could get
  await ctx.impd.broker.readExecEnv(imp, vsock);

  expect(ctx.installs).toStrictEqual([vsock, vsock]);
});

test('it keeps the newest audit rows of each imp', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.imps.create({ name: 'dev' });

  // one past the cap, oldest first
  for (let index = 0; index < AUDIT_ROWS_PER_IMP + 5; index += 1) {
    await writeAuditEntry(ctx.db, {
      impId: dev.id,
      secretName: 'gh',
      at: new Date(),
      method: 'GET',
      host: 'api.github.com',
      path: `/${String(index)}`,
      status: 200,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: 1,
    });
  }

  const rows = await listAuditEntries(ctx.db, dev.id, 2000, null);

  expect(rows).toHaveLength(AUDIT_ROWS_PER_IMP);
  expect(rows[0]?.path).toBe(`/${String(AUDIT_ROWS_PER_IMP + 4)}`);
});

test('it lists the audit rows of an imp newest first, up to the limit', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.imps.create({ name: 'dev' });

  for (const path of ['/a', '/b', '/c']) {
    await writeAuditEntry(ctx.db, {
      impId: dev.id,
      secretName: 'gh',
      at: new Date(),
      method: 'GET',
      host: 'api.github.com',
      path,
      status: 200,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: 1,
    });
  }

  const listed = await ctx.client.audit.list({ name: 'dev', limit: 2 });

  expect(listed.map((row) => row.path)).toStrictEqual(['/c', '/b']);
});

test('it caps an audit listing at 1000 rows whatever the limit asked', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.imps.create({ name: 'dev' });
  const other = await ctx.client.imps.create({ name: 'other' });

  // two imps, each under its own cap, together past 1000
  for (const impId of [dev.id, other.id]) {
    for (let index = 0; index < 550; index += 1) {
      await writeAuditEntry(ctx.db, {
        impId,
        secretName: 'gh',
        at: new Date(),
        method: 'GET',
        host: 'api.github.com',
        path: `/${String(index)}`,
        status: 200,
        requestBytes: 0,
        responseBytes: 0,
        durationMs: 1,
      });
    }
  }

  const rows = await ctx.impd.broker.listAudit(null, 5000, null);

  expect(rows).toHaveLength(1000);
});

test('it lists only the audit rows of imps within the patterns', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.imps.create({ name: 'dev' });
  const other = await ctx.client.imps.create({ name: 'other' });

  for (const impId of [dev.id, other.id]) {
    await writeAuditEntry(ctx.db, {
      impId,
      secretName: 'gh',
      at: new Date(),
      method: 'GET',
      host: 'api.github.com',
      path: '/user',
      status: 200,
      requestBytes: 0,
      responseBytes: 0,
      durationMs: 1,
    });
  }

  const rows = await ctx.impd.broker.listAudit(null, 10, ['de*']);

  expect(rows.map((row) => row.imp)).toStrictEqual(['dev']);
});

test('it removes the audit rows of a destroyed imp', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.imps.create({ name: 'dev' });

  await writeAuditEntry(ctx.db, {
    impId: dev.id,
    secretName: 'gh',
    at: new Date(),
    method: 'GET',
    host: 'api.github.com',
    path: '/user',
    status: 200,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: 1,
  });

  await ctx.client.imps.destroy({ name: 'dev' });

  const left = await listAuditEntries(ctx.db, null, 10, null);

  expect(left).toStrictEqual([]);
});

test('it reports a fork whose grants cannot be copied, and logs the cause', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  // the fork is gone by the time the grants are copied
  const report = await ctx.impd.broker.createForkGrants(dev, { id: 'gone', name: 'gone' }, null);

  expect(report).toStrictEqual({
    notCopied: [],
    error:
      "the source's grants could not be copied, so the fork has none; impd's log has the cause",
  });

  expect(ctx.logs).toContainEqual(
    expect.toStartWith('impd: gone: forked without the grants of dev: '),
  );
});

test('it copies no grant to a fork whose token was removed, and says so', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.imps.create({ name: 'dev' });
  const copy = await ctx.client.imps.create({ name: 'copy' });

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const secret = await findSecret(ctx.db, 'gh');

  invariant(secret);

  const report = await ctx.impd.broker.createForkGrants(dev, copy, {
    tokenId: 'removed-token',
    grantable: [{ name: 'gh', generation: secret.generation }],
  });

  const grants = await ctx.client.grants.list({ name: 'copy' });

  expect(report).toStrictEqual({
    notCopied: [],
    error: "the token behind this fork was removed, so it got none of the source's grants",
  });

  expect(grants).toStrictEqual([]);
  expect(ctx.logs).toContain('impd: copy: forked without the grants of dev: the token was removed');
});

test('it skips a grant the caller may not make on a fork, and logs why', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.imps.create({ name: 'dev' });
  const copy = await ctx.client.imps.create({ name: 'copy' });

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  // a caller whose list grants nothing
  const report = await ctx.impd.broker.createForkGrants(dev, copy, {
    tokenId: null,
    grantable: [],
  });

  expect(report).toStrictEqual({
    notCopied: [{ secret: 'gh', reason: 'not-grantable' }],
    error: null,
  });

  expect(ctx.logs).toContain(
    'impd: copy: forked without grant gh of dev: the caller may not grant it',
  );
});

test('it skips a grant that clashes on a fork, and logs why', async () => {
  const ctx = await setupTest();
  const dev = await ctx.client.imps.create({ name: 'dev' });
  const copy = await ctx.client.imps.create({ name: 'copy' });

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  await ctx.client.secrets.add({
    name: 'gh-api',
    kind: 'custom',
    value: 'ghp_SECRETVALUE0123456789',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.client.grants.add({ name: 'copy', secret: 'gh-api' });

  const report = await ctx.impd.broker.createForkGrants(dev, copy, null);

  expect(report).toStrictEqual({ notCopied: [{ secret: 'gh', reason: 'clash' }], error: null });

  expect(ctx.logs).toContain(
    'impd: copy: forked without grant gh of dev: it has another credential for that host',
  );
});

test('it keeps the old value and makes no new file when a replace clashes', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });

  await ctx.client.secrets.add({
    name: 'claude',
    kind: 'anthropic',
    value: 'ghp_SECRETVALUE0123456789',
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });
  await ctx.client.grants.add({ name: 'dev', secret: 'claude' });

  const before = await findSecret(ctx.db, 'claude');

  // claude moving onto gh's host would give dev two credentials for it
  const clash = ctx.client.secrets.add({
    name: 'claude',
    kind: 'custom',
    value: 'other',
    rules: [buildMockBrokerRule({ host: 'api.github.com' })],
    replace: true,
  });

  expect(clash).rejects.toMatchObject({ code: 'CONFLICT' });

  invariant(before);

  const after = await findSecret(ctx.db, 'claude');
  const value = await readFile(join(ctx.dataDir, 'secrets', before.valueFile), 'utf8');
  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(after).toStrictEqual(before);
  expect(value).toBe('ghp_SECRETVALUE0123456789');
  expect(files).toHaveLength(2);
});

test('it logs a grant change it could not apply rather than throw', async () => {
  const ctx = await setupTest();

  await sql`ALTER TABLE grants RENAME TO grants_gone`.execute(ctx.db);
  await ctx.impd.broker.applyGrants();

  expect(ctx.logs).toContainEqual(expect.toStartWith('impd: broker: could not apply grants: '));
});

test('it logs an audit row it could not write and still answers the request', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRETVALUE0123456789' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  await sql`CREATE TRIGGER fail_audit BEFORE INSERT ON broker_audit
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END`.execute(ctx.db);

  server.use(http.get('https://api.github.com/user', () => HttpResponse.text('from upstream')));

  const port = await ctx.impd.broker.listen(0);
  const ca = await readFile(join(ctx.dataDir, 'broker', 'ca', 'ca.pem'), 'utf8');

  const established = Promise.withResolvers<Socket>();

  // slot 0's guest, 127.0.0.2, through its gateway's front port
  const tunnel = createConnection({ host: '127.0.0.1', port, localAddress: '127.0.0.2' }, () => {
    tunnel.write('CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com:443\r\n\r\n');
  });

  onTestFinished(() => {
    tunnel.destroy();
  });

  tunnel.once('data', () => {
    established.resolve(tunnel);
  });

  const secure = connectTls({
    socket: await established.promise,
    servername: 'api.github.com',
    ca,
  });

  const chunks: Buffer[] = [];
  const ended = Promise.withResolvers<void>();

  secure.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  secure.once('end', ended.resolve);
  secure.write('GET /user HTTP/1.1\r\nHost: api.github.com\r\nConnection: close\r\n\r\n');

  await ended.promise;

  const logged = await waitFor(() => {
    const line = ctx.logs.find((each) => each.startsWith('impd: broker: audit write failed'));

    invariant(line);

    return line;
  });

  expect(Buffer.concat(chunks).toString()).toMatch(/^HTTP\/1\.1 200 [\s\S]*from upstream$/u);
  expect(logged).toBe('impd: broker: audit write failed: forced failure');
});

test('it refuses a tunnel into the imps’ IPv6 prefix', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const prefix = parsePrefix64('fd12:3456:789a:1::/64');

  invariant(prefix);

  const broker = await createBroker({
    config: ctx.config,
    db: ctx.db,
    log: () => {},
    ipv6: { prefix, nat66: false, uplink: null },
    runOAuthTimer: false,
  });

  ctx.stack.defer(() => broker.stop());

  const port = await broker.listen(0);

  // slot 0's guest, 127.0.0.2
  const guest = await startStubBrokerGuestSocket(ctx.stack, { port, address: '127.0.0.2' });

  guest.write('CONNECT [fd12:3456:789a:1::9]:443 HTTP/1.1\r\n\r\n');

  const reply = await guest.reply;

  expect(reply).toBe(
    'HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: 82\r\nconnection: close\r\n\r\n' +
      'fd12:3456:789a:1::9 resolves to fd12:3456:789a:1::9, which a tunnel may not reach\n',
  );
});

test('it dials a public IPv6 address when impd has IPv6', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const prefix = parsePrefix64('fd12:3456:789a:1::/64');

  invariant(prefix);

  const dialled: string[] = [];

  // the far end of the tunnel, on loopback
  const target = await startStubBrokerReplyTarget(ctx.stack, 'tunnel');

  const broker = await createBroker({
    config: ctx.config,
    db: ctx.db,
    log: () => {},
    ipv6: { prefix, nat66: false, uplink: null },
    runOAuthTimer: false,
    dialTunnel: (host) => {
      dialled.push(host);

      return createConnection({ host: '127.0.0.1', port: target.port });
    },
  });

  ctx.stack.defer(() => broker.stop());

  const port = await broker.listen(0);

  // slot 0's guest, 127.0.0.2
  const guest = await startStubBrokerGuestSocket(ctx.stack, { port, address: '127.0.0.2' });

  // the head and the request behind it, which the target reads before it
  // answers
  guest.write(
    'CONNECT [2606:4700::1111]:443 HTTP/1.1\r\n\r\nGET / HTTP/1.1\r\nHost: example.com\r\n\r\n',
  );

  const reply = await guest.reply;

  expect(reply).toBe(
    'HTTP/1.1 200 Connection Established\r\n\r\n' +
      'HTTP/1.1 200 OK\r\ncontent-length: 6\r\nconnection: close\r\n\r\ntunnel',
  );

  expect(dialled).toStrictEqual(['2606:4700::1111']);
  expect(target.received).toStrictEqual(['GET / HTTP/1.1\r\nHost: example.com\r\n\r\n']);
});

test('it refuses every IPv6 tunnel when impd has no IPv6', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev' });

  const broker = await createBroker({
    config: ctx.config,
    db: ctx.db,
    log: () => {},
    runOAuthTimer: false,
  });

  ctx.stack.defer(() => broker.stop());

  const port = await broker.listen(0);

  // slot 0's guest, 127.0.0.2
  const guest = await startStubBrokerGuestSocket(ctx.stack, { port, address: '127.0.0.2' });

  guest.write('CONNECT [2606:4700::1111]:443 HTTP/1.1\r\n\r\n');

  const reply = await guest.reply;

  expect(reply).toBe(
    'HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\ncontent-length: 74\r\nconnection: close\r\n\r\n' +
      '2606:4700::1111 resolves to 2606:4700::1111, which a tunnel may not reach\n',
  );
});
