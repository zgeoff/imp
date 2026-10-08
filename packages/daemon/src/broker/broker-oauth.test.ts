import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { buildMockBrokerRule } from '@imp/api/test-utils/build-mock-broker-rule';
import { buildMockOAuthConfig } from '@imp/api/test-utils/build-mock-oauth-config';
import { server } from '@imp/test-utils/mock-server';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { createImage } from '../db/images';
import { openDatabase } from '../db/open-database';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubBrokerGuest } from '../test-utils/build-stub-broker-guest';
import { buildStubBrokerTokenEndpoint } from '../test-utils/build-stub-broker-token-endpoint';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { startStubBrokerTlsUpstream } from '../test-utils/start-stub-broker-tls-upstream';

// An oauth secret through the broker on loopback, as in broker.test.ts. A
// fake API host answers through the test-upstreams file over TLS the broker
// verifies; the token endpoint is an MSW handler, and every token is made up.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'broker-oauth-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the fake API host, with its own CA the broker is told to trust
  const apiSeen: { path: string; authorization: string | null }[] = [];

  const api = await startStubBrokerTlsUpstream(stack, {
    dir: join(dataDir, 'api'),
    fetch: (request) => {
      apiSeen.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
      });

      return new Response('from the api');
    },
  });

  // the broker reads the file when a request comes
  const upstreamsFile = join(dataDir, 'upstreams.json');

  await writeFile(
    upstreamsFile,
    JSON.stringify({ ca: api.caPem, upstreams: { 'api.example.com': api.origin } }),
  );

  // a loopback subnet, so a local address stands for a guest; the stub VMM
  // runs no jailer; each impd's resolver takes a free port
  const config = loadConfig({
    IMP_DATA_DIR: dataDir,
    IMP_JAILER: 'false',
    IMP_BOOT_TEMPLATES: 'false',
    IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
    IMP_SUBNET: '127.0.0.0/16',
    IMP_BROKER_TEST_UPSTREAMS: upstreamsFile,
  });

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

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

  // the image every imp boots from
  await Bun.write(join(dataDir, 'images', 'base', 'rootfs.ext4'), 'rootfs');

  await createImage(db, { name: 'base', ref: 'base:latest', digest: 'sha256:base', sizeBytes: 6 });

  const proxyPort = await impd.broker.listen(0);

  const link = new RPCLink({
    url: 'http://impd.test/rpc',
    headers: { authorization: 'Bearer root-token' },
    fetch: (request) => impd.api.app.handle(request),
  });

  const client: ContractRouterClient<ImpContract> = createORPCClient(link);

  return {
    stack,
    dataDir,
    upstreamsFile,
    impd,
    client,
    apiSeen,

    // slot 0's guest
    guest: buildStubBrokerGuest({
      proxyPort,
      caFile: join(dataDir, 'broker', 'ca', 'ca.pem'),
      address: '127.0.0.2',
    }),
  };
}

test('it sends the current access token to the granted host', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  endpoint.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    expires_in: 3600,
  });

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  await ctx.impd.broker.addGrant('dev', 'codex');

  const result = await ctx.guest.curl('https://api.example.com/v1', [
    '-H',
    'Authorization: Bearer imp-broker-placeholder',
  ]);

  expect(result).toStrictEqual({ code: 0, stdout: 'from the api', stderr: '' });
  expect(ctx.apiSeen).toStrictEqual([{ path: '/v1', authorization: 'Bearer fake-access-1' }]);
});

test('it sends the new access token after a refresh that used the rotated refresh token', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  endpoint.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    expires_in: 3600,
  });

  endpoint.issue('fake-refresh-1', {
    access_token: 'fake-access-2',
    refresh_token: 'fake-refresh-2',
    expires_in: 3600,
  });

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  await ctx.impd.broker.addGrant('dev', 'codex');
  await ctx.impd.broker.refreshSecret('codex');
  await ctx.guest.curl('https://api.example.com/v2');

  expect(ctx.apiSeen).toStrictEqual([{ path: '/v2', authorization: 'Bearer fake-access-2' }]);

  expect(endpoint.requests.map((request) => request.refreshToken)).toStrictEqual([
    'fake-refresh-0',
    'fake-refresh-1',
  ]);
});

test('it gives no credential for a secret with no access token', async () => {
  const ctx = await setupTest();

  // no answer is issued, so the first sign-in gets invalid_grant
  server.use(buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token').handler);

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  await ctx.impd.broker.addGrant('dev', 'codex');

  const result = await ctx.guest.curl('https://api.example.com/v1', ['-w', '%{http_code}']);

  expect(result).toStrictEqual({
    code: 0,
    stdout: 'no credential is granted for api.example.com\n403',
    stderr: '',
  });

  expect(ctx.apiSeen).toStrictEqual([]);
});

test('it keeps sending the valid access token of a secret that needs a new sign-in', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);

  // the sign-in works; the refresh token it returns is dead by the refresh
  endpoint.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    expires_in: 3600,
  });

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  await ctx.impd.broker.addGrant('dev', 'codex');

  const refreshed = await ctx.impd.broker.refreshSecret('codex');

  await ctx.guest.curl('https://api.example.com/v2');

  expect(refreshed.oauth?.status).toBe('needs_login');
  expect(ctx.apiSeen).toStrictEqual([{ path: '/v2', authorization: 'Bearer fake-access-1' }]);
});

test('it answers a websocket upgrade 426 and never reaches the upstream', async () => {
  const ctx = await setupTest();

  const endpoint = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(endpoint.handler);
  endpoint.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  await ctx.client.imps.create({ name: 'dev' });

  await ctx.impd.broker.addSecret({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  await ctx.impd.broker.addGrant('dev', 'codex');

  const result = await ctx.guest.curl('https://api.example.com/socket', [
    '-H',
    'Connection: Upgrade',
    '-H',
    'Upgrade: websocket',
    '-w',
    '%{http_code}',
  ]);

  expect(result).toStrictEqual({
    code: 0,
    stdout: 'websocket upgrades are not supported through the broker\n426',
    stderr: '',
  });

  expect(ctx.apiSeen).toStrictEqual([]);
});

test('it refreshes through a token host that the test-upstreams file routes', async () => {
  const ctx = await setupTest();

  const refreshTokens: string[] = [];

  // the token host over TLS the broker verifies with the file's CA
  const tokenHost = await startStubBrokerTlsUpstream(ctx.stack, {
    dir: join(ctx.dataDir, 'token-host'),
    fetch: async (request) => {
      const text = await request.text();

      const form = new URLSearchParams(text);

      refreshTokens.push(form.get('refresh_token') ?? '');

      return Response.json({
        access_token: 'fake-access-1',
        refresh_token: 'fake-refresh-1',
        expires_in: 3600,
      });
    },
  });

  await writeFile(
    ctx.upstreamsFile,
    JSON.stringify({ ca: tokenHost.caPem, upstreams: { 'auth.example.com': tokenHost.origin } }),
  );

  await ctx.impd.broker.addSecret({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  const refreshed = await ctx.impd.broker.refreshSecret('codex');

  expect(refreshed.oauth?.status).toBe('ready');
  expect(refreshTokens).toStrictEqual(['fake-refresh-0', 'fake-refresh-1']);
});
