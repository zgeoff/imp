import { expect, onTestFinished, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@imp/api';
import { buildMockBrokerRule } from '@imp/api/test-utils/build-mock-broker-rule';
import { buildMockOAuthConfig } from '@imp/api/test-utils/build-mock-oauth-config';
import { invariant } from '@imp/test-utils/invariant';
import { server } from '@imp/test-utils/mock-server';
import { waitFor } from '@imp/test-utils/wait-for';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { HttpResponse, http } from 'msw';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { createImage } from '../db/images';
import { openDatabase } from '../db/open-database';
import { findSecret, removeSecret } from '../db/secrets';
import type { SecretRecord } from '../db/secrets';
import { buildSystemDrivePath, buildSystemDrivesDir } from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildStubBrokerJwt } from '../test-utils/build-stub-broker-jwt';
import { buildStubBrokerTokenEndpoint } from '../test-utils/build-stub-broker-token-endpoint';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { findFreePorts } from '../test-utils/find-free-ports';
import { createBroker } from './broker-service';

// An oauth secret through the API, against a token endpoint MSW answers;
// every token is made up (docs/guides/connectors.md#oauth-secrets).

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'oauth-secrets-'));

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

  // the token endpoint every secret in these tests names
  const tokens = buildStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(tokens.handler);

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

  const client: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: 'Bearer root-token' },
      fetch: (request) => impd.api.app.handle(request),
    }),
  );

  return { stack, config, db, dataDir, tokens, impd, client };
}

test('it sends the first refresh once the row is committed', async () => {
  const ctx = await setupTest();

  const seen: { row: SecretRecord | undefined } = { row: undefined };

  server.use(
    http.post('https://auth.example.com/oauth/token', async () => {
      seen.row = await findSecret(ctx.db, 'codex');
    }),
  );

  ctx.tokens.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'fake-client',
      tokenFormat: 'json',
    }),
  });

  expect(ctx.tokens.requests).toStrictEqual([
    {
      contentType: 'application/json',
      accept: 'application/json',
      body: '{"grant_type":"refresh_token","refresh_token":"fake-refresh-0","client_id":"fake-client"}',
      refreshToken: 'fake-refresh-0',
    },
  ]);

  expect(seen.row?.name).toBe('codex');
});

test('it answers a signed-in oauth secret ready, with its account claims only', async () => {
  const ctx = await setupTest();

  ctx.tokens.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    id_token: buildStubBrokerJwt({
      email: 'someone@example.com',
      sub: 'fake-subject',
      at_hash: 'x',
      c_hash: 'x',
      nonce: 'x',
      sid: 'x',
      jti: 'x',
    }),
    expires_in: 3600,
  });

  const config = buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' });

  const added: unknown = await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: config,
  });

  expect(added).toStrictEqual({
    name: 'codex',
    kind: 'oauth',
    rules: [{ host: 'api.example.com', header: 'authorization', scheme: 'bearer' }],
    imps: [],
    createdAt: expect.any(Date) as unknown,
    droppedGrants: 0,
    oauth: {
      ...config,
      status: 'ready',
      expiresAt: expect.any(Date) as unknown,
      refreshedAt: expect.any(Date) as unknown,
      error: null,
      idClaims: { email: 'someone@example.com', sub: 'fake-subject' },
    },
  });
});

test('it never shows a token of an oauth secret through the API', async () => {
  const ctx = await setupTest();

  const idToken = buildStubBrokerJwt({ email: 'someone@example.com' });

  ctx.tokens.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    id_token: idToken,
    expires_in: 3600,
  });

  const added = await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  const listed = await ctx.client.secrets.list();
  const info = await ctx.client.system.info();
  const audit = await ctx.client.audit.list({});
  const calls = await ctx.client.audit.calls({});

  const everything = JSON.stringify([added, listed, info, audit, calls]);

  expect(everything).not.toMatch(/fake-(?:access|refresh)|eyJ/u);
});

test('it stores the rotated tokens in the value file', async () => {
  const ctx = await setupTest();

  ctx.tokens.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    expires_in: 3600,
  });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  const secret = await findSecret(ctx.db, 'codex');

  invariant(secret);

  const text = await readFile(join(ctx.dataDir, 'secrets', secret.valueFile), 'utf8');

  const stored: unknown = JSON.parse(text);

  expect(stored).toStrictEqual({
    v: 1,
    refreshToken: 'fake-refresh-1',
    accessToken: 'fake-access-1',
    idToken: null,
    expiresAt: expect.any(Number) as unknown,
    refreshedAt: expect.any(Number) as unknown,
    status: 'ready',
    error: null,
  });
});

test('it answers an oauth secret whose first refresh fails pending', async () => {
  const ctx = await setupTest();

  server.use(
    http.post(
      'https://auth.example.com/oauth/token',
      () => HttpResponse.json({ error: 'unavailable' }, { status: 503 }),
      { once: true },
    ),
  );

  const config = buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' });

  const added = await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: config,
  });

  expect(added.oauth).toStrictEqual({
    ...config,
    status: 'pending',
    expiresAt: null,
    refreshedAt: null,
    error: 'HTTP 503',
    idClaims: null,
  });
});

test('it lists an oauth secret whose refresh token is dead as needing a new sign-in', async () => {
  const ctx = await setupTest();

  const config = buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' });

  // the endpoint has no answer for fake-refresh-0: invalid_grant
  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: config,
  });

  const listed = await ctx.client.secrets.list();

  expect(listed[0]?.oauth).toStrictEqual({
    ...config,
    status: 'needs_login',
    expiresAt: null,
    refreshedAt: null,
    error: 'invalid_grant',
    idClaims: null,
  });
});

test('it rejects an oauth secret without its token endpoint', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.secrets.add({
      name: 'codex',
      kind: 'oauth',
      value: 'fake-refresh-0',
      rules: [buildMockBrokerRule()],
    }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'kind oauth needs a token URL and a client id',
  });
});

test('it rejects an oauth secret without hosts', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.secrets.add({
      name: 'codex',
      kind: 'oauth',
      value: 'fake-refresh-0',
      oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'kind oauth needs at least one host' });
});

test('it rejects a token endpoint on a preset secret', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.secrets.add({
      name: 'gh',
      kind: 'github',
      value: 'x',
      oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'kind github has no token URL or client id; they are for kind oauth',
  });
});

test('it rejects a token endpoint on a custom secret', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.secrets.add({
      name: 'api',
      kind: 'custom',
      value: 'x',
      rules: [buildMockBrokerRule()],
      oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'kind custom has no token URL or client id; they are for kind oauth',
  });
});

test.each([
  [
    'a plain HTTP token URL',
    { tokenUrl: 'http://auth.example.com/token', clientId: 'app_imp', tokenFormat: 'form' },
    'tokenUrl',
  ],
  [
    'a client id with a space',
    { tokenUrl: 'https://auth.example.com/token', clientId: 'has space', tokenFormat: 'form' },
    'clientId',
  ],
  [
    'a token format it does not speak',
    { tokenUrl: 'https://auth.example.com/token', clientId: 'app_imp', tokenFormat: 'xml' },
    'tokenFormat',
  ],
])('it rejects %s', async (_, oauth, field) => {
  const ctx = await setupTest();

  const added = ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- input the contract refuses
    oauth: oauth as never,
  });

  expect(added).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    data: { issues: expect.toPartiallyContain({ path: ['oauth', field] }) },
  });
});

test('it sends nothing to the token endpoint for a refused oauth secret', async () => {
  const ctx = await setupTest();

  const added = ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
  });

  expect(added).rejects.toMatchObject({ code: 'BAD_REQUEST' });

  const listed = await ctx.client.secrets.list();

  expect(ctx.tokens.requests).toStrictEqual([]);
  expect(listed).toStrictEqual([]);
});

test('it keeps the grant through a new refresh token for the same endpoint', async () => {
  const ctx = await setupTest();

  const config = buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' });

  ctx.tokens.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });
  ctx.tokens.issue('fake-refresh-new', { access_token: 'fake-access-2', expires_in: 3600 });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: config,
  });

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.grants.add({ name: 'dev', secret: 'codex' });

  const rotated = await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-new',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: config,
    replace: true,
  });

  expect(rotated.droppedGrants).toBe(0);

  expect(ctx.tokens.requests.map((request) => request.refreshToken)).toStrictEqual([
    'fake-refresh-0',
    'fake-refresh-new',
  ]);
});

test.each([
  ['token URL', { tokenUrl: 'https://auth.example.org/oauth/token' }],
  ['client', { clientId: 'fake-other' }],
  ['token format', { tokenFormat: 'json' }],
] as const)('it refuses another %s without a rebind', async (_, override) => {
  const ctx = await setupTest();

  const config = buildMockOAuthConfig({
    tokenUrl: 'https://auth.example.com/oauth/token',
    clientId: 'fake-client',
    tokenFormat: 'form',
  });

  ctx.tokens.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: config,
  });

  expect(
    ctx.client.secrets.add({
      name: 'codex',
      kind: 'oauth',
      value: 'fake-refresh-0',
      rules: [buildMockBrokerRule({ host: 'api.example.com' })],
      oauth: { ...config, ...override },
      replace: true,
    }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});

test('it takes another client and drops the grants on a rebind', async () => {
  const ctx = await setupTest();

  const config = buildMockOAuthConfig({
    tokenUrl: 'https://auth.example.com/oauth/token',
    clientId: 'fake-client',
  });

  ctx.tokens.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });
  ctx.tokens.issue('fake-refresh-0', { access_token: 'fake-access-2', expires_in: 3600 });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: config,
  });

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.grants.add({ name: 'dev', secret: 'codex' });

  const rebound = await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: { ...config, clientId: 'fake-other' },
    replace: true,
    rebind: true,
  });

  expect(rebound.droppedGrants).toBe(1);
  expect(rebound.oauth?.clientId).toBe('fake-other');
});

test('it refreshes on request with the rotated token and answers after it', async () => {
  const ctx = await setupTest();

  ctx.tokens.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    expires_in: 3600,
  });

  ctx.tokens.issue('fake-refresh-1', {
    access_token: 'fake-access-2',
    refresh_token: 'fake-refresh-2',
    expires_in: 3600,
  });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  const refreshed = await ctx.client.secrets.refresh({ name: 'codex' });
  const secret = await findSecret(ctx.db, 'codex');

  invariant(secret);

  const text = await readFile(join(ctx.dataDir, 'secrets', secret.valueFile), 'utf8');

  const stored: unknown = JSON.parse(text);

  expect(refreshed.oauth?.status).toBe('ready');

  expect(ctx.tokens.requests.map((request) => request.refreshToken)).toStrictEqual([
    'fake-refresh-0',
    'fake-refresh-1',
  ]);

  expect(stored).toStrictEqual({
    v: 1,
    refreshToken: 'fake-refresh-2',
    accessToken: 'fake-access-2',
    idToken: null,
    expiresAt: expect.any(Number) as unknown,
    refreshedAt: expect.any(Number) as unknown,
    status: 'ready',
    error: null,
  });
});

test('it answers a forced refresh of a dead refresh token as needing a new sign-in', async () => {
  const ctx = await setupTest();

  ctx.tokens.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  server.use(
    http.post('https://auth.example.com/oauth/token', () => HttpResponse.json({}, { status: 401 })),
  );

  const dead = await ctx.client.secrets.refresh({ name: 'codex' });

  expect(dead.oauth?.status).toBe('needs_login');
  expect(dead.oauth?.error).toBe('HTTP 401');
});

test('it refuses a refresh of a secret that is not oauth', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_x' });

  expect(ctx.client.secrets.refresh({ name: 'gh' })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'secret gh is not an oauth secret',
  });
});

test('it refuses a refresh of a secret that does not exist', async () => {
  const ctx = await setupTest();

  expect(ctx.client.secrets.refresh({ name: 'nothing' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'secret', name: 'nothing' },
  });
});

test('it holds a replace behind a refresh under way, which never overwrites it', async () => {
  const ctx = await setupTest();

  const config = buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' });

  ctx.tokens.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
  });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: config,
  });

  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();

  // the next token call waits at the endpoint until the gate opens
  server.use(
    http.post(
      'https://auth.example.com/oauth/token',
      async () => {
        reached.resolve();

        await gate.promise;
      },
      { once: true },
    ),
  );

  ctx.tokens.issue('fake-refresh-1', {
    access_token: 'fake-access-2',
    refresh_token: 'fake-refresh-2',
  });

  ctx.tokens.issue('fake-refresh-replacement', {
    access_token: 'fake-access-3',
    refresh_token: 'fake-refresh-3',
  });

  const refreshing = ctx.client.secrets.refresh({ name: 'codex' });

  await reached.promise;

  const replacing = ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-replacement',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: config,
    replace: true,
  });

  gate.resolve();

  await Promise.all([refreshing, replacing]);

  const secret = await findSecret(ctx.db, 'codex');

  invariant(secret);

  const text = await readFile(join(ctx.dataDir, 'secrets', secret.valueFile), 'utf8');

  const stored: unknown = JSON.parse(text);

  // the replace's own call came only after the held refresh had answered
  expect(ctx.tokens.requests.map((request) => request.refreshToken)).toStrictEqual([
    'fake-refresh-0',
    'fake-refresh-1',
    'fake-refresh-replacement',
  ]);

  expect(stored).toStrictEqual({
    v: 1,
    refreshToken: 'fake-refresh-3',
    accessToken: 'fake-access-3',
    idToken: null,
    expiresAt: null,
    refreshedAt: expect.any(Number) as unknown,
    status: 'ready',
    error: null,
  });
});

test('it holds a delete behind a refresh under way, then removes the secret', async () => {
  const ctx = await setupTest();

  ctx.tokens.issue('fake-refresh-0', { access_token: 'fake-access-1' });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const seen: { row: SecretRecord | undefined } = { row: undefined };

  // the next token call waits at the endpoint, then reads the row as it answers
  server.use(
    http.post(
      'https://auth.example.com/oauth/token',
      async () => {
        reached.resolve();

        await gate.promise;

        seen.row = await findSecret(ctx.db, 'codex');
      },
      { once: true },
    ),
  );

  ctx.tokens.issue('fake-refresh-0', {
    access_token: 'fake-access-2',
    refresh_token: 'fake-refresh-2',
  });

  const refreshing = ctx.client.secrets.refresh({ name: 'codex' });

  await reached.promise;

  const deleting = ctx.client.secrets.delete({ name: 'codex' });

  gate.resolve();

  expect(refreshing).rejects.toMatchObject({ code: 'NOT_FOUND' });

  await deleting;

  const gone = await findSecret(ctx.db, 'codex');

  expect(seen.row?.name).toBe('codex');
  expect(gone).toBeUndefined();
});

test('it answers not found for a secret deleted outside the lock during its refresh', async () => {
  const ctx = await setupTest();

  ctx.tokens.issue('fake-refresh-0', { access_token: 'fake-access-1' });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();

  // the next token call waits at the endpoint until the gate opens
  server.use(
    http.post(
      'https://auth.example.com/oauth/token',
      async () => {
        reached.resolve();

        await gate.promise;
      },
      { once: true },
    ),
  );

  ctx.tokens.issue('fake-refresh-0', { access_token: 'fake-access-2' });

  const refreshing = ctx.client.secrets.refresh({ name: 'codex' });

  await reached.promise;

  // as a bug or a restore would
  await removeSecret(ctx.db, 'codex');

  gate.resolve();

  expect(refreshing).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'secret', name: 'codex' },
  });
});

test('it shows an oauth secret whose value file is gone as needing a new sign-in', async () => {
  const ctx = await setupTest();

  ctx.tokens.issue('fake-refresh-0', { access_token: 'fake-access-1' });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  const secret = await findSecret(ctx.db, 'codex');

  invariant(secret);

  await rm(join(ctx.dataDir, 'secrets', secret.valueFile));

  const listed = await ctx.client.secrets.list();

  expect(listed[0]?.oauth?.status).toBe('needs_login');
  expect(listed[0]?.oauth?.error).toBe('value file missing or unreadable');
});

test('it refreshes a pending secret when the broker starts', async () => {
  const ctx = await setupTest();

  // the first sign-in meets a network error, so the secret stays pending
  server.use(
    http.post('https://auth.example.com/oauth/token', () => HttpResponse.error(), { once: true }),
  );

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  ctx.tokens.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  // the refresh timer runs, as at a real start: its first tick is at once,
  // and its next is a minute away, past the test's end
  const started = await createBroker({ config: ctx.config, db: ctx.db, log: () => {} });

  ctx.stack.defer(() => started.stop());

  const sent = await waitFor(() => {
    const [request] = ctx.tokens.requests;

    invariant(request);

    return request.refreshToken;
  });

  expect(sent).toBe('fake-refresh-0');
});
