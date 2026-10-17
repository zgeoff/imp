import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalCodeSchema } from '@impz/api';
import type { ImpContract } from '@impz/api';
import { waitFor } from '@impz/test-utils/wait-for';
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthTokens,
} from '@modelcontextprotocol/client';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import invariant from 'tiny-invariant';
import * as z from 'zod';
import { readMcpAnswer } from '../../../mcp/src/test-utils/read-mcp-answer';
import { loadConfig } from '../config';
import { createImpd } from '../create-impd';
import { listApiCalls } from '../db/api-audit';
import { createImage } from '../db/images';
import { findImpByName } from '../db/imps';
import { openDatabase } from '../db/open-database';
import {
  buildImagePaths,
  buildImpPaths,
  buildSystemDrivePath,
  buildSystemDrivesDir,
} from '../storage/data-layout';
import { createXfsBackend } from '../storage/xfs-backend';
import { buildMockNewImage } from '../test-utils/build-mock-new-image';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { buildStubExecGuest } from '../test-utils/build-stub-exec-guest';
import { buildStubMcpTransport } from '../test-utils/build-stub-mcp-transport';
import { buildStubVmm } from '../test-utils/build-stub-vmm';
import { createPendingSignIn } from '../test-utils/create-pending-sign-in';
import { findFreePorts } from '../test-utils/find-free-ports';
import { runOAuthSignIn } from '../test-utils/run-oauth-sign-in';
import { startStubExecAgent } from '../test-utils/start-stub-exec-agent';
import { createPublicHandler, startPublicListener } from './public-listener';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'public-listener-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  // the public route on loopback, as tests name it; the stub VMM runs no
  // jailer and builds no boot template; the resolver binds its port on
  // every address, so each impd takes a free one
  const config = loadConfig({
    IMP_DATA_DIR: dataDir,
    IMP_JAILER: 'false',
    IMP_BOOT_TEMPLATES: 'false',
    IMP_EGRESS_DNS_PORT: String(findFreePorts(1).take()),
    IMP_MCP_PUBLIC_URL: 'http://127.0.0.1:7171',
    IMP_MCP_PUBLIC_PORT: '7171',
  });

  // the system drive impd boots imps with, as setupSystemFiles installs it
  const drive = 'd1'.repeat(32);
  const systemDrivePath = buildSystemDrivePath(dataDir, drive);

  await mkdir(buildSystemDrivesDir(dataDir), { recursive: true });
  await writeFile(systemDrivePath, drive);

  const vmm = buildStubVmm();

  // this impd's own root token, which its root client sends
  const rootToken = randomUUID();

  const impd = await createImpd(config, {
    db,
    rootToken,
    storage: createXfsBackend({ dataDir, cloneFile: (source, target) => copyFile(source, target) }),
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

    // the wall clock: better-auth checks its sessions and tokens against it,
    // and a sign-in bucket refills one start per 6 s, longer than a test
    now: Date.now,
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
  });

  stack.defer(() => {
    impd.diskUsage.stop();
  });

  stack.defer(() => impd.api.publicMcp.close());

  const publicMcp = config.publicMcp;

  invariant(publicMcp);

  const client: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: { authorization: `Bearer ${rootToken}` },
      fetch: (request) => impd.api.app.handle(request),
    }),
  );

  return {
    stack,
    db,
    dataDir,
    impd,
    rootToken,
    client,
    publicMcp,

    // the public route's handler over impd's own OAuth service and /mcp
    handle: createPublicHandler({ config: publicMcp, oauth: impd.oauth, mcp: impd.api.publicMcp }),
  };
}

test.each([
  ['/.well-known/oauth-protected-resource/mcp'],
  ['/.well-known/oauth-protected-resource'],
])('it serves the protected resource metadata at %s', async (path) => {
  const ctx = await setupTest();

  const response = await ctx.handle(
    new Request(`http://127.0.0.1:7171${path}`, { headers: { host: '127.0.0.1:7171' } }),
    null,
  );

  const json: unknown = await response.json();

  const body = z.record(z.string(), z.unknown()).parse(json);

  expect(response.status).toBe(200);

  expect(body).toMatchObject({
    resource: 'http://127.0.0.1:7171/mcp',
    authorization_servers: ['http://127.0.0.1:7171'],
    bearer_methods_supported: ['header'],
    resource_name: 'imp',
  });

  expect(
    Object.keys(body).filter((key) => key.startsWith('introspection_') || key.startsWith('dpop_')),
  ).toStrictEqual([]);
});

test('it serves the authorization server metadata, with public clients only and nothing on introspection or DPoP', async () => {
  const ctx = await setupTest();

  const response = await ctx.handle(
    new Request(`http://127.0.0.1:7171/.well-known/oauth-authorization-server`, {
      headers: { host: '127.0.0.1:7171' },
    }),
    null,
  );

  const json: unknown = await response.json();

  const body = z.record(z.string(), z.unknown()).parse(json);

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');

  expect(body).toMatchObject({
    issuer: 'http://127.0.0.1:7171',
    authorization_endpoint: 'http://127.0.0.1:7171/oauth2/authorize',
    token_endpoint: 'http://127.0.0.1:7171/oauth2/token',
    code_challenge_methods_supported: expect.arrayContaining(['S256']) as unknown,
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
  });

  expect(
    Object.keys(body).filter((key) => key.startsWith('introspection_') || key.startsWith('dpop_')),
  ).toStrictEqual([]);
});

test.each([['/rpc/system/info'], ['/health'], ['/auth/login'], ['/exec'], ['/'], ['/index.html']])(
  'it answers the private path %s with the same 404, even with the root token',
  async (path) => {
    const ctx = await setupTest();

    const response = await ctx.handle(
      new Request(`http://127.0.0.1:7171${path}`, {
        headers: { host: '127.0.0.1:7171', authorization: `Bearer ${ctx.rootToken}` },
      }),
      null,
    );

    expect({ status: response.status, body: await response.text() }).toStrictEqual({
      status: 404,
      body: 'not found',
    });
  },
);

test.each([['evil.example'], ['127.0.0.1:7070'], ['localhost:7171']])(
  'it answers the host %s, which the front did not route here, with a 404',
  async (host) => {
    const ctx = await setupTest();

    const response = await ctx.handle(
      new Request(`http://127.0.0.1:7171/.well-known/oauth-authorization-server`, {
        headers: { host },
      }),
      null,
    );

    expect(response.status).toBe(404);
  },
);

test.each([
  ['no credentials', {}],
  [
    'a peer and forwarded headers',
    { 'x-forwarded-for': '100.101.102.103', 'x-imp-peer': '100.101.102.103' },
  ],
  [
    'a client address and a session cookie',
    { 'cf-connecting-ip': '127.0.0.1', cookie: 'imp_session=anything' },
  ],
  ['a guessed access token', { authorization: 'Bearer impat_guess.wrong' }],
])('it refuses /mcp with %s, as it takes only an OAuth access token', async (_what, headers) => {
  const ctx = await setupTest();

  const response = await ctx.handle(
    new Request('http://127.0.0.1:7171/mcp', {
      method: 'POST',
      headers: { host: '127.0.0.1:7171', 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    }),
    null,
  );

  expect({
    status: response.status,
    challenge: response.headers.get('www-authenticate'),
  }).toStrictEqual({
    status: 401,
    challenge:
      'Bearer resource_metadata="http://127.0.0.1:7171/.well-known/oauth-protected-resource/mcp", scope="read"',
  });
});

test('it refuses /mcp with the root token, as it takes only an OAuth access token', async () => {
  const ctx = await setupTest();

  const response = await ctx.handle(
    new Request('http://127.0.0.1:7171/mcp', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.rootToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    }),
    null,
  );

  expect({
    status: response.status,
    challenge: response.headers.get('www-authenticate'),
  }).toStrictEqual({
    status: 401,
    challenge:
      'Bearer resource_metadata="http://127.0.0.1:7171/.well-known/oauth-protected-resource/mcp", scope="read"',
  });
});

test('it refuses /mcp with a named imp token', async () => {
  const ctx = await setupTest();
  const named = await ctx.impd.tokens.create({ name: 'named', scope: 'manage', imps: null });

  const response = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        authorization: `Bearer ${named.secret}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    }),
    null,
  );

  expect({
    status: response.status,
    challenge: response.headers.get('www-authenticate'),
  }).toStrictEqual({
    status: 401,
    challenge:
      'Bearer resource_metadata="http://127.0.0.1:7171/.well-known/oauth-protected-resource/mcp", scope="read"',
  });
});

test('it sends the sign-in page with headers that keep it from being framed, cached or referred', async () => {
  const ctx = await setupTest();
  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);

  const pending = await createPendingSignIn({
    handle: (request) => ctx.handle(request, null),
    origin: 'http://127.0.0.1:7171',
    clientID: oauthClient.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'read',
  });

  const response = await ctx.handle(
    new Request(`http://127.0.0.1:7171/login?${pending.oauthQuery}`, {
      headers: { host: '127.0.0.1:7171' },
    }),
    null,
  );

  expect({
    status: response.status,
    referrer: response.headers.get('referrer-policy'),
    frame: response.headers.get('x-frame-options'),
    cache: response.headers.get('cache-control'),
    policy: response.headers.get('content-security-policy'),
  }).toStrictEqual({
    status: 200,
    referrer: 'same-origin',
    frame: 'DENY',
    cache: 'no-store',
    policy:
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://client.example; frame-ancestors 'none'; base-uri 'none'",
  });
});

test('it escapes the redirect URI that the consent page shows after approval', async () => {
  const ctx = await setupTest();

  const oauthClient = await ctx.impd.oauth.addClient('conn', [
    'https://client.example/cb?next=%22%3E&x=<b>"\'',
  ]);

  const made = await ctx.impd.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.impd.tokens.authenticate(made.secret);

  invariant(approver);

  const pending = await createPendingSignIn({
    handle: (request) => ctx.handle(request, null),
    origin: 'http://127.0.0.1:7171',
    clientID: oauthClient.clientId,
    redirectURI: 'https://client.example/cb?next=%22%3E&x=<b>"\'',
    scope: 'read',
  });

  ctx.impd.oauth.approve(ApprovalCodeSchema.parse(pending.code), approver, 'read', undefined);

  const continued = await ctx.handle(
    new Request('http://127.0.0.1:7171/login', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://127.0.0.1:7171',
      },
      body: new URLSearchParams({ oauth_query: pending.oauthQuery, action: 'continue' }),
    }),
    null,
  );

  const consentURL = new URL(continued.headers.get('location') ?? '');

  const cookie = continued.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const confirmed = await ctx.handle(
    new Request(consentURL.href, { headers: { host: '127.0.0.1:7171', cookie } }),
    null,
  );

  const text = await confirmed.text();

  expect(text).toInclude('<strong>read</strong>');
  expect(text).toInclude('x=&lt;b&gt;&quot;&#39;');
  expect(text).not.toInclude('<b>"');
});

test('it never sends a sign-in for a client it does not know to its redirect URI or the login page', async () => {
  const ctx = await setupTest();

  const response = await ctx.handle(
    new Request(
      `http://127.0.0.1:7171/oauth2/authorize?response_type=code&client_id=impc_guess&redirect_uri=https://evil.example&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256`,
      { headers: { host: '127.0.0.1:7171' } },
    ),
    null,
  );

  const location = response.headers.get('location') ?? '';

  expect(response.status).toBeGreaterThanOrEqual(300);
  expect(location).not.toInclude('evil.example');
  expect(location).not.toInclude('/login');
});

test('it answers a too-busy sign-in with a 429 and when to try again', async () => {
  const ctx = await setupTest();
  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: oauthClient.clientId,
    redirect_uri: 'https://client.example/callback',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    scope: 'read',
  });

  // the burst of 10 sign-ins a client may start at once
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      await ctx.handle(
        new Request(`http://127.0.0.1:7171/oauth2/authorize?${query.toString()}`, {
          headers: { host: '127.0.0.1:7171' },
        }),
        null,
      );
    }),
  );

  const response = await ctx.handle(
    new Request(`http://127.0.0.1:7171/oauth2/authorize?${query.toString()}`, {
      headers: { host: '127.0.0.1:7171' },
    }),
    null,
  );

  expect({ status: response.status, retry: response.headers.get('retry-after') }).toStrictEqual({
    status: 429,
    retry: '6',
  });
});

test.each([
  [{ origin: 'http://127.0.0.1:7171' }, 200],
  [{ origin: 'null', 'sec-fetch-site': 'same-origin' }, 200],
  [{ origin: 'null' }, 400],
  [{ origin: 'null', 'sec-fetch-site': 'cross-site' }, 400],
  [{ 'sec-fetch-site': 'same-origin' }, 400],
  [{ origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' }, 400],
  [{}, 400],
])('it answers a sign-in form posted with %p with %p', async (headers, status) => {
  const ctx = await setupTest();
  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);

  const pending = await createPendingSignIn({
    handle: (request) => ctx.handle(request, null),
    origin: 'http://127.0.0.1:7171',
    clientID: oauthClient.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'read',
  });

  const posted = await ctx.handle(
    new Request('http://127.0.0.1:7171/login', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      body: new URLSearchParams({ oauth_query: pending.oauthQuery, action: 'continue' }),
    }),
    null,
  );

  expect(posted.status).toBe(status);
});

test('it refuses a sign-in form with an action it does not know', async () => {
  const ctx = await setupTest();
  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);

  const pending = await createPendingSignIn({
    handle: (request) => ctx.handle(request, null),
    origin: 'http://127.0.0.1:7171',
    clientID: oauthClient.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'read',
  });

  const response = await ctx.handle(
    new Request('http://127.0.0.1:7171/login', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://127.0.0.1:7171',
      },
      body: new URLSearchParams({ oauth_query: pending.oauthQuery, action: 'maybe' }),
    }),
    null,
  );

  expect(response.status).toBe(400);
});

test('it refuses a token request from a client it does not know', async () => {
  const ctx = await setupTest();

  const response = await ctx.handle(
    new Request('http://127.0.0.1:7171/oauth2/token', {
      method: 'POST',
      headers: { host: '127.0.0.1:7171', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: 'impc_guess',
        refresh_token: 'not-a-refresh-token',
      }),
    }),
    null,
  );

  expect(response.status).toBeOneOf([400, 401]);
  expect(response.headers.get('cache-control')).toInclude('no-store');
});

test('it ends the grant whose client revokes its refresh token, and refuses its access token', async () => {
  const ctx = await setupTest();
  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.impd.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.impd.tokens.authenticate(made.secret);

  invariant(approver);

  const tokens = await runOAuthSignIn(
    {
      handle: (request) => ctx.handle(request, null),
      origin: 'http://127.0.0.1:7171',
      clientID: oauthClient.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.impd.oauth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  const revoked = await ctx.handle(
    new Request('http://127.0.0.1:7171/oauth2/revoke', {
      method: 'POST',
      headers: { host: '127.0.0.1:7171', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: oauthClient.clientId,
        token: tokens.refresh_token,
        token_type_hint: 'refresh_token',
      }),
    }),
    null,
  );

  const after = await ctx.handle(
    new Request('http://127.0.0.1:7171/mcp', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    }),
    null,
  );

  const grants = await ctx.impd.oauth.listGrants();

  expect(revoked.status).toBe(200);
  expect(grants).toStrictEqual([]);
  expect(after.status).toBe(401);
});

test('it signs a client in over HTTP to tokens for the approved scope, sending no referrer on the redirect', async () => {
  const ctx = await setupTest();
  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.impd.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.impd.tokens.authenticate(made.secret);

  invariant(approver);

  const pending = await createPendingSignIn({
    handle: (request) => ctx.handle(request, null),
    origin: 'http://127.0.0.1:7171',
    clientID: oauthClient.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'read exec manage',
  });

  ctx.impd.oauth.approve(ApprovalCodeSchema.parse(pending.code), approver, 'exec', undefined);

  const continued = await ctx.handle(
    new Request('http://127.0.0.1:7171/login', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://127.0.0.1:7171',
      },
      body: new URLSearchParams({ oauth_query: pending.oauthQuery, action: 'continue' }),
    }),
    null,
  );

  const consentURL = new URL(continued.headers.get('location') ?? '');

  const cookie = continued.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const consentQuery = consentURL.search.slice(1);

  const allowed = await ctx.handle(
    new Request('http://127.0.0.1:7171/consent', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://127.0.0.1:7171',
        cookie,
      },
      body: new URLSearchParams({ oauth_query: consentQuery, action: 'allow' }),
    }),
    null,
  );

  const redirect = new URL(allowed.headers.get('location') ?? '');

  const issuedCode = redirect.searchParams.get('code') ?? '';

  const issued = await ctx.handle(
    new Request('http://127.0.0.1:7171/oauth2/token', {
      method: 'POST',
      headers: { host: '127.0.0.1:7171', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: oauthClient.clientId,
        code: issuedCode,
        redirect_uri: 'https://client.example/callback',
        code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        resource: 'http://127.0.0.1:7171/mcp',
      }),
    }),
    null,
  );

  const issuedBody: unknown = await issued.json();

  const tokens = z.object({ access_token: z.string(), scope: z.string() }).parse(issuedBody);

  expect(consentURL.pathname).toBe('/consent');
  expect(allowed.headers.get('referrer-policy')).toBe('no-referrer');
  expect(`${redirect.origin}${redirect.pathname}`).toBe('https://client.example/callback');
  expect(tokens.scope).toBe('read exec offline_access');
});

test('it signs an MCP client in through its OAuth provider and lists the tools its grant allows', async () => {
  const ctx = await setupTest();

  const origin = 'http://127.0.0.1:7171';

  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.impd.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.impd.tokens.authenticate(made.secret);

  invariant(approver);

  const listener = startPublicListener(
    {
      config: { ...ctx.publicMcp, port: 0 },
      oauth: ctx.impd.oauth,
      mcp: ctx.impd.api.publicMcp,
    },
    () => {},
  );

  ctx.stack.defer(() => listener.stop());

  // the operator's front: a request for the route's origin goes to the
  // listener's own port, with the origin's host
  const sendThroughFront = (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = new URL(url);

    target.port = String(listener.port);

    const headers = new Headers(init?.headers);

    headers.set('host', '127.0.0.1:7171');

    return fetch(target, { ...init, headers, redirect: 'manual' });
  };

  // what the client keeps between its runs, as a connector stores it
  const saved: {
    tokens?: OAuthTokens;
    discovery?: OAuthDiscoveryState;
    verifier: string;
    authorizationURL: URL | null;
  } = { verifier: '', authorizationURL: null };

  const provider: OAuthClientProvider = {
    redirectUrl: 'https://client.example/callback',
    clientMetadata: {
      client_name: 'conn',
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'read exec',
    },
    clientInformation: () => ({ client_id: oauthClient.clientId }),
    tokens: () => saved.tokens,
    saveTokens: (tokens) => {
      saved.tokens = tokens;
    },
    redirectToAuthorization: (url) => {
      saved.authorizationURL = url;
    },
    saveCodeVerifier: (verifier) => {
      saved.verifier = verifier;
    },
    codeVerifier: () => saved.verifier,
    saveDiscoveryState: (state) => {
      saved.discovery = state;
    },
    discoveryState: () => saved.discovery,
  };

  const unsigned = new Client({ name: 'test', version: '1.0.0' });

  const first = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    authProvider: provider,
    fetch: sendThroughFront,
  });

  const refused = await unsigned.connect(first).then(
    () => null,
    (error: unknown) => error,
  );

  invariant(saved.authorizationURL);

  const authorized = await sendThroughFront(saved.authorizationURL);

  const loginURL = new URL(authorized.headers.get('location') ?? '', origin);

  const login = await sendThroughFront(loginURL);
  const loginPage = await login.text();

  const code = /impz oauth approve (?<code>[A-Z0-9\-]+)/v.exec(loginPage)?.groups?.['code'] ?? '';

  // the client asks for the scope the route's 401 names, read
  ctx.impd.oauth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);

  const continued = await sendThroughFront(`${origin}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: new URLSearchParams({ oauth_query: loginURL.search.slice(1), action: 'continue' }),
  });

  const consentURL = new URL(continued.headers.get('location') ?? '', origin);

  const cookie = continued.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const allowed = await sendThroughFront(`${origin}/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin, cookie },
    body: new URLSearchParams({ oauth_query: consentURL.search.slice(1), action: 'allow' }),
  });

  const back = new URL(allowed.headers.get('location') ?? '');

  // the redirect's whole query, code and iss, as the client's callback reads it
  await first.finishAuth(back.searchParams);

  const client = new Client({ name: 'test', version: '1.0.0' });

  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      authProvider: provider,
      fetch: sendThroughFront,
    }),
  );

  ctx.stack.defer(() => client.close());

  const listed = await client.listTools();

  expect(refused).toBeInstanceOf(UnauthorizedError);

  expect(listed.tools.map((tool) => tool.name)).toStrictEqual([
    'imp_list',
    'imp_url',
    'imp_image_list',
    'imp_checkpoint_list',
  ]);
});

test('it lists an exec grant’s tools over /mcp, without the manage ones', async () => {
  const ctx = await setupTest();
  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.impd.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.impd.tokens.authenticate(made.secret);

  invariant(approver);

  const tokens = await runOAuthSignIn(
    {
      handle: (request) => ctx.handle(request, null),
      origin: 'http://127.0.0.1:7171',
      clientID: oauthClient.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read exec manage',
    },
    (code) => {
      ctx.impd.oauth.approve(ApprovalCodeSchema.parse(code), approver, 'exec', undefined);
    },
  );

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  // read to its end, as a client does, so it holds no slot
  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  const listing = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
    null,
  );

  const json = await readMcpAnswer(listing);

  const ToolSchema = z.object({ name: z.string() });
  const listed = z.object({ result: z.object({ tools: z.array(ToolSchema) }) }).parse(json);

  expect(listed.result.tools.map((tool) => tool.name)).toContain('imp_exec');
  expect(listed.result.tools.map((tool) => tool.name)).not.toContain('imp_create');
});

test('it ends a grant’s running command when the grant is revoked', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'box' });

  const boxImp = await findImpByName(ctx.db, 'box');

  invariant(boxImp);

  const boxAgent = await startStubExecAgent(
    buildImpPaths(ctx.dataDir, boxImp.id).vsockSocket,
    guest,
  );

  // closed before impd stops; its own fallback close then does nothing
  ctx.stack.defer(() => {
    boxAgent.close();
  });

  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.impd.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.impd.tokens.authenticate(made.secret);

  invariant(approver);

  const tokens = await runOAuthSignIn(
    {
      handle: (request) => ctx.handle(request, null),
      origin: 'http://127.0.0.1:7171',
      clientID: oauthClient.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read exec manage',
    },
    (code) => {
      ctx.impd.oauth.approve(ApprovalCodeSchema.parse(code), approver, 'exec', undefined);
    },
  );

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  // read to its end, as a client does, so it holds no slot
  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  const call = (async () => {
    const response = await ctx.handle(
      new Request(`http://127.0.0.1:7171/mcp`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:7171',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${tokens.access_token}`,
          'mcp-session-id': mcpSession,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
        }),
      }),
      null,
    );

    return response.text();
  })();

  await waitFor(() => {
    expect(guest.requests).toHaveLength(1);
  });

  const [listed] = await ctx.impd.oauth.listGrants();

  invariant(listed);

  await ctx.impd.oauth.removeGrant(listed.id);

  const text = await call;

  await waitFor(() => {
    expect(guest.closed).toStrictEqual(['sleepy']);
  });

  // the stream ends with no result for the call
  expect(text).toBe('');
});

test('it refuses /mcp to a revoked grant’s session', async () => {
  const ctx = await setupTest();
  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.impd.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.impd.tokens.authenticate(made.secret);

  invariant(approver);

  const tokens = await runOAuthSignIn(
    {
      handle: (request) => ctx.handle(request, null),
      origin: 'http://127.0.0.1:7171',
      clientID: oauthClient.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read exec manage',
    },
    (code) => {
      ctx.impd.oauth.approve(ApprovalCodeSchema.parse(code), approver, 'exec', undefined);
    },
  );

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  // read to its end, as a client does, so it holds no slot
  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  const [listed] = await ctx.impd.oauth.listGrants();

  invariant(listed);

  await ctx.impd.oauth.removeGrant(listed.id);

  const after = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }),
    }),
    null,
  );

  expect(after.status).toBe(401);
});

test('it ends the grant a removed token approved, and its running command', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'box' });

  const boxImp = await findImpByName(ctx.db, 'box');

  invariant(boxImp);

  const boxAgent = await startStubExecAgent(
    buildImpPaths(ctx.dataDir, boxImp.id).vsockSocket,
    guest,
  );

  // closed before impd stops; its own fallback close then does nothing
  ctx.stack.defer(() => {
    boxAgent.close();
  });

  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.impd.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.impd.tokens.authenticate(made.secret);

  invariant(approver);

  const tokens = await runOAuthSignIn(
    {
      handle: (request) => ctx.handle(request, null),
      origin: 'http://127.0.0.1:7171',
      clientID: oauthClient.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read exec manage',
    },
    (code) => {
      ctx.impd.oauth.approve(ApprovalCodeSchema.parse(code), approver, 'exec', undefined);
    },
  );

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  // read to its end, as a client does, so it holds no slot
  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  const call = (async () => {
    const response = await ctx.handle(
      new Request(`http://127.0.0.1:7171/mcp`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:7171',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${tokens.access_token}`,
          'mcp-session-id': mcpSession,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
        }),
      }),
      null,
    );

    return response.text();
  })();

  await waitFor(() => {
    expect(guest.requests).toHaveLength(1);
  });

  await ctx.impd.tokens.remove('laptop');

  const after = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }),
    }),
    null,
  );

  const text = await call;

  await waitFor(() => {
    expect(guest.closed).toStrictEqual(['sleepy']);
  });

  expect(after.status).toBe(401);
  expect(text).toBe('');
});

test('it lists only the read tools to a read grant', async () => {
  const ctx = await setupTest();
  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.impd.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.impd.tokens.authenticate(made.secret);

  invariant(approver);

  const tokens = await runOAuthSignIn(
    {
      handle: (request) => ctx.handle(request, null),
      origin: 'http://127.0.0.1:7171',
      clientID: oauthClient.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read exec manage',
    },
    (code) => {
      ctx.impd.oauth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  // read to its end, as a client does, so it holds no slot
  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  const listing = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
    null,
  );

  const json = await readMcpAnswer(listing);

  const ToolSchema = z.object({ name: z.string() });
  const listed = z.object({ result: z.object({ tools: z.array(ToolSchema) }) }).parse(json);

  expect(listed.result.tools.map((tool) => tool.name)).toStrictEqual([
    'imp_list',
    'imp_url',
    'imp_image_list',
    'imp_checkpoint_list',
  ]);
});

test.each([
  ['read', undefined, 'dev-a', 'a read grant'],
  ['exec', ['dev-*'], 'box', 'a grant for dev-*'],
] as const)(
  'it refuses an exec by a %s grant with patterns %p on %s, past %s, and audits nothing',
  async (scope, imps, name) => {
    const ctx = await setupTest();

    const guest = buildStubExecGuest();
    const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

    await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

    await createImage(ctx.db, image);

    await ctx.client.imps.create({ name: 'box' });

    const boxImp = await findImpByName(ctx.db, 'box');

    invariant(boxImp);

    const boxAgent = await startStubExecAgent(
      buildImpPaths(ctx.dataDir, boxImp.id).vsockSocket,
      guest,
    );

    // closed before impd stops; its own fallback close then does nothing
    ctx.stack.defer(() => {
      boxAgent.close();
    });

    await ctx.client.imps.create({ name: 'dev-a' });

    const devaImp = await findImpByName(ctx.db, 'dev-a');

    invariant(devaImp);

    const devaAgent = await startStubExecAgent(
      buildImpPaths(ctx.dataDir, devaImp.id).vsockSocket,
      guest,
    );

    // closed before impd stops; its own fallback close then does nothing
    ctx.stack.defer(() => {
      devaAgent.close();
    });

    const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);
    const made = await ctx.impd.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

    const approver = ctx.impd.tokens.authenticate(made.secret);

    invariant(approver);

    const tokens = await runOAuthSignIn(
      {
        handle: (request) => ctx.handle(request, null),
        origin: 'http://127.0.0.1:7171',
        clientID: oauthClient.clientId,
        redirectURI: 'https://client.example/callback',
        scope: 'read exec manage',
      },
      (code) => {
        ctx.impd.oauth.approve(ApprovalCodeSchema.parse(code), approver, scope, imps);
      },
    );

    const mcpOpened = await ctx.handle(
      new Request(`http://127.0.0.1:7171/mcp`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:7171',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${tokens.access_token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      }),
      null,
    );

    // read to its end, as a client does, so it holds no slot
    await mcpOpened.text();

    const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

    const called = await ctx.handle(
      new Request(`http://127.0.0.1:7171/mcp`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:7171',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${tokens.access_token}`,
          'mcp-session-id': mcpSession,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'imp_exec', arguments: { name, command: 'echo hi' } },
        }),
      }),
      null,
    );

    const text = await called.text();

    const data = text.split('\n').find((line) => line.startsWith('data: '));

    invariant(data !== undefined);

    const json: unknown = JSON.parse(data.slice('data: '.length));
    const item = z.object({ text: z.string() });
    const result = z.object({ result: z.object({ content: z.array(item) }) }).parse(json);

    const calls = await listApiCalls(ctx.db, null, 100, null);

    expect(result.result.content[0]?.text).toStartWith('FORBIDDEN:');
    expect(guest.requests).toStrictEqual([]);
    expect(calls.filter((call) => call.actor === 'oauth')).toStrictEqual([]);
  },
);

test('it audits a grant’s change under its client and grant id', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'dev-a' });

  const devaImp = await findImpByName(ctx.db, 'dev-a');

  invariant(devaImp);

  const devaAgent = await startStubExecAgent(
    buildImpPaths(ctx.dataDir, devaImp.id).vsockSocket,
    guest,
  );

  // closed before impd stops; its own fallback close then does nothing
  ctx.stack.defer(() => {
    devaAgent.close();
  });

  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.impd.tokens.create({ name: 'desk', scope: 'manage', imps: null });

  const approver = ctx.impd.tokens.authenticate(made.secret);

  invariant(approver);

  const tokens = await runOAuthSignIn(
    {
      handle: (request) => ctx.handle(request, null),
      origin: 'http://127.0.0.1:7171',
      clientID: oauthClient.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read exec manage',
    },
    (code) => {
      ctx.impd.oauth.approve(ApprovalCodeSchema.parse(code), approver, 'exec', ['dev-*']);
    },
  );

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  // read to its end, as a client does, so it holds no slot
  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  const slept = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'imp_sleep', arguments: { name: 'dev-a' } },
      }),
    }),
    null,
  );

  await slept.text();

  const [listed] = await ctx.impd.oauth.listGrants();
  const calls = await listApiCalls(ctx.db, null, 100, null);

  invariant(listed);

  expect(
    calls.filter((call) => call.actor === 'oauth').map((call) => [call.procedure, call.actorName]),
  ).toStrictEqual([['imps.sleep', `conn/${listed.id}`]]);
});

test('it audits a grant’s change refused past its patterns as FORBIDDEN', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'box' });

  const boxImp = await findImpByName(ctx.db, 'box');

  invariant(boxImp);

  const boxAgent = await startStubExecAgent(
    buildImpPaths(ctx.dataDir, boxImp.id).vsockSocket,
    guest,
  );

  // closed before impd stops; its own fallback close then does nothing
  ctx.stack.defer(() => {
    boxAgent.close();
  });

  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.impd.tokens.create({ name: 'desk', scope: 'manage', imps: null });

  const approver = ctx.impd.tokens.authenticate(made.secret);

  invariant(approver);

  const tokens = await runOAuthSignIn(
    {
      handle: (request) => ctx.handle(request, null),
      origin: 'http://127.0.0.1:7171',
      clientID: oauthClient.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read exec manage',
    },
    (code) => {
      ctx.impd.oauth.approve(ApprovalCodeSchema.parse(code), approver, 'exec', ['dev-*']);
    },
  );

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  // read to its end, as a client does, so it holds no slot
  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  const slept = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'imp_sleep', arguments: { name: 'box' } },
      }),
    }),
    null,
  );

  const text = await slept.text();
  const calls = await listApiCalls(ctx.db, null, 100, null);
  const [listed] = await ctx.impd.oauth.listGrants();

  invariant(listed);

  expect(text).toInclude('FORBIDDEN:');

  expect(
    calls
      .filter((call) => call.actor === 'oauth')
      .map((call) => [call.procedure, call.actorName, call.outcome]),
  ).toStrictEqual([['imps.sleep', `conn/${listed.id}`, 'FORBIDDEN']]);
});

test('it serves the route on its own port, for its own host only', async () => {
  const ctx = await setupTest();

  const listener = startPublicListener(
    {
      config: { ...ctx.publicMcp, port: 0 },
      oauth: ctx.impd.oauth,
      mcp: buildStubMcpTransport(),
    },
    () => {},
  );

  ctx.stack.defer(() => listener.stop());

  const url = `http://127.0.0.1:${String(listener.port)}/.well-known/oauth-authorization-server`;

  const [found, elsewhere] = await Promise.all([
    fetch(url, { headers: { host: '127.0.0.1:7171' } }),
    fetch(url),
  ]);

  expect(found.status).toBe(200);
  expect(elsewhere.status).toBe(404);
});

test('it closes the MCP transport when the listener stops', async () => {
  const ctx = await setupTest();

  const transport = buildStubMcpTransport();

  const listener = startPublicListener(
    { config: { ...ctx.publicMcp, port: 0 }, oauth: ctx.impd.oauth, mcp: transport },
    () => {},
  );

  ctx.stack.defer(() => listener.stop());

  await listener.stop();

  expect(transport.closes).toBe(1);
});

test('it logs where the listener serves the route', async () => {
  const ctx = await setupTest();

  const logs: string[] = [];

  const listener = startPublicListener(
    { config: { ...ctx.publicMcp, port: 0 }, oauth: ctx.impd.oauth, mcp: buildStubMcpTransport() },
    (line) => {
      logs.push(line);
    },
  );

  ctx.stack.defer(() => listener.stop());

  expect(logs).toStrictEqual([`impd: public mcp on :0 for ${ctx.publicMcp.origin}`]);
});

test('it answers a request that throws with a bare 500, and logs the reason', async () => {
  const ctx = await setupTest();

  const logs: string[] = [];

  const listener = startPublicListener(
    {
      config: { ...ctx.publicMcp, port: 0 },
      oauth: ctx.impd.oauth,
      mcp: buildStubMcpTransport({ failure: new Error('the transport broke') }),
    },
    (line) => {
      logs.push(line);
    },
  );

  ctx.stack.defer(() => listener.stop());

  const response = await fetch(`http://127.0.0.1:${String(listener.port)}/mcp`, {
    method: 'POST',
    headers: { host: '127.0.0.1:7171' },
  });

  const body = await response.text();

  expect(response.status).toBe(500);
  expect(body).toBe('internal error');
  expect(logs).toContain('impd: public mcp: the transport broke');
});

test('it takes 64 open tool calls at once', async () => {
  const ctx = await setupTest();

  const handle = createPublicHandler({
    config: ctx.publicMcp,
    oauth: ctx.impd.oauth,
    mcp: buildStubMcpTransport(),
  });

  const statuses = await Promise.all(
    Array.from({ length: 64 }, async () => {
      const response = await handle(
        new Request(`http://127.0.0.1:7171/mcp`, {
          method: 'POST',
          headers: { host: '127.0.0.1:7171' },
        }),
        null,
      );

      await response.body?.cancel();

      return response.status;
    }),
  );

  expect(statuses).toStrictEqual(Array.from({ length: 64 }, () => 200));
});

test('it keeps a tool call’s slot until the tool ends, though its client goes', async () => {
  const ctx = await setupTest();

  const transport = buildStubMcpTransport();

  const handle = createPublicHandler({
    config: ctx.publicMcp,
    oauth: ctx.impd.oauth,
    mcp: transport,
  });

  // 64 long calls whose clients go away at once fill every slot

  await Promise.all(
    Array.from({ length: 64 }, async () => {
      const response = await handle(
        new Request(`http://127.0.0.1:7171/mcp`, {
          method: 'POST',
          headers: { host: '127.0.0.1:7171' },
        }),
        null,
      );

      await response.body?.cancel();
    }),
  );

  const refused = await handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: { host: '127.0.0.1:7171' },
    }),
    null,
  );

  expect(refused.status).toBe(429);
});

test('it frees a tool call’s slot once the tool ends', async () => {
  const ctx = await setupTest();

  const transport = buildStubMcpTransport();

  const handle = createPublicHandler({
    config: ctx.publicMcp,
    oauth: ctx.impd.oauth,
    mcp: transport,
  });

  // 64 long calls whose clients go away at once fill every slot

  await Promise.all(
    Array.from({ length: 64 }, async () => {
      const response = await handle(
        new Request(`http://127.0.0.1:7171/mcp`, {
          method: 'POST',
          headers: { host: '127.0.0.1:7171' },
        }),
        null,
      );

      await response.body?.cancel();
    }),
  );

  const refused = await handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: { host: '127.0.0.1:7171' },
    }),
    null,
  );

  const [first] = transport.calls;

  invariant(first);

  first.end();

  const next = await waitFor(async () => {
    const response = await handle(
      new Request(`http://127.0.0.1:7171/mcp`, {
        method: 'POST',
        headers: { host: '127.0.0.1:7171' },
      }),
      null,
    );

    expect(response.status).toBe(200);

    return response;
  });

  expect(refused.status).toBe(429);
  expect(next.status).toBe(200);
});

test('it reads at most 16 bodies at once for requests past every slot', async () => {
  const ctx = await setupTest();

  const transport = buildStubMcpTransport();

  const handle = createPublicHandler({
    config: ctx.publicMcp,
    oauth: ctx.impd.oauth,
    mcp: transport,
  });

  // 64 calls that never end hold every slot

  await Promise.all(
    Array.from({ length: 64 }, async () => {
      const response = await handle(
        new Request(`http://127.0.0.1:7171/mcp`, {
          method: 'POST',
          headers: { host: '127.0.0.1:7171' },
        }),
        null,
      );

      await response.body?.cancel();
    }),
  );

  // 33 bodies that never finish; each records whether anything read it
  const reads = Array.from({ length: 33 }, () => false);
  const outcomes: (number | 'waiting')[] = Array.from({ length: 33 }, () => 'waiting');

  for (const [index] of reads.entries()) {
    const body = new ReadableStream<Uint8Array>(
      {
        pull: () => {
          reads[index] = true;

          return new Promise<void>(() => {});
        },
      },
      { highWaterMark: 0 },
    );

    const request = new Request('http://127.0.0.1:7171/mcp', {
      method: 'POST',
      headers: { host: '127.0.0.1:7171', 'content-type': 'application/json' },
      body,
    });

    void (async () => {
      const response = await handle(request, null);

      outcomes[index] = response.status;
    })();
  }

  await waitFor(() => {
    expect(reads.slice(0, 16)).toSatisfyAll((read: boolean) => read);
    expect(outcomes.slice(16)).toSatisfyAll((outcome: number | 'waiting') => outcome === 429);
  });

  expect(outcomes.slice(0, 16)).toStrictEqual(Array.from({ length: 16 }, () => 'waiting'));
  expect(reads.slice(16)).toStrictEqual(Array.from({ length: 17 }, () => false));
});

test('it lets a cancel through with every slot held, which stops its tool and frees a slot', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'box' });

  const boxImp = await findImpByName(ctx.db, 'box');

  invariant(boxImp);

  const boxAgent = await startStubExecAgent(
    buildImpPaths(ctx.dataDir, boxImp.id).vsockSocket,
    guest,
  );

  // closed before impd stops; its own fallback close then does nothing
  ctx.stack.defer(() => {
    boxAgent.close();
  });

  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.impd.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.impd.tokens.authenticate(made.secret);

  invariant(approver);

  const tokens = await runOAuthSignIn(
    {
      handle: (request) => ctx.handle(request, null),
      origin: 'http://127.0.0.1:7171',
      clientID: oauthClient.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read exec manage',
    },
    (code) => {
      ctx.impd.oauth.approve(ApprovalCodeSchema.parse(code), approver, 'exec', undefined);
    },
  );

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  // read to its end, as a client does, so it holds no slot
  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  // 64 long calls whose clients go away at once fill every slot

  await Promise.all(
    Array.from({ length: 64 }, async (_, offset) => {
      const response = await ctx.handle(
        new Request(`http://127.0.0.1:7171/mcp`, {
          method: 'POST',
          headers: {
            host: '127.0.0.1:7171',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${tokens.access_token}`,
            'mcp-session-id': mcpSession,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: offset + 1,
            method: 'tools/call',
            params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
          }),
        }),
        null,
      );

      await response.body?.cancel();
    }),
  );

  await waitFor(() => {
    expect(guest.requests).toHaveLength(64);
  });

  // impd still holds every slot though each client went
  const refused = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'ping' }),
    }),
    null,
  );

  const cancelled = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 1 },
      }),
    }),
    null,
  );

  await waitFor(() => {
    expect(guest.signals).toContain('sleepy:15');
  });

  const next = await waitFor(async () => {
    const response = await ctx.handle(
      new Request(`http://127.0.0.1:7171/mcp`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:7171',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${tokens.access_token}`,
          'mcp-session-id': mcpSession,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'ping' }),
      }),
      null,
    );

    await response.text();

    expect(response.status).toBe(200);

    return response;
  });

  expect(refused.status).toBe(429);
  expect(cancelled.status).toBe(202);
  expect(next.status).toBe(200);
});

test('it refuses a request that starts work with every slot held', async () => {
  const ctx = await setupTest();

  const transport = buildStubMcpTransport();

  const handle = createPublicHandler({
    config: ctx.publicMcp,
    oauth: ctx.impd.oauth,
    mcp: transport,
  });

  // 64 long calls whose clients go away at once fill every slot

  await Promise.all(
    Array.from({ length: 64 }, async () => {
      const response = await handle(
        new Request(`http://127.0.0.1:7171/mcp`, {
          method: 'POST',
          headers: { host: '127.0.0.1:7171' },
        }),
        null,
      );

      await response.body?.cancel();
    }),
  );

  const refused = await handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: { host: '127.0.0.1:7171', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'ping' }),
    }),
    null,
  );

  expect(refused.status).toBe(429);
});

test('it refuses a signed-in notification too large for the allowance with every slot held', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'box' });

  const boxImp = await findImpByName(ctx.db, 'box');

  invariant(boxImp);

  const boxAgent = await startStubExecAgent(
    buildImpPaths(ctx.dataDir, boxImp.id).vsockSocket,
    guest,
  );

  // closed before impd stops; its own fallback close then does nothing
  ctx.stack.defer(() => {
    boxAgent.close();
  });

  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.impd.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.impd.tokens.authenticate(made.secret);

  invariant(approver);

  const tokens = await runOAuthSignIn(
    {
      handle: (request) => ctx.handle(request, null),
      origin: 'http://127.0.0.1:7171',
      clientID: oauthClient.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read exec manage',
    },
    (code) => {
      ctx.impd.oauth.approve(ApprovalCodeSchema.parse(code), approver, 'exec', undefined);
    },
  );

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  // read to its end, as a client does, so it holds no slot
  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  // 64 long calls whose clients go away at once fill every slot

  await Promise.all(
    Array.from({ length: 64 }, async (_, offset) => {
      const response = await ctx.handle(
        new Request(`http://127.0.0.1:7171/mcp`, {
          method: 'POST',
          headers: {
            host: '127.0.0.1:7171',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${tokens.access_token}`,
            'mcp-session-id': mcpSession,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: offset + 1,
            method: 'tools/call',
            params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
          }),
        }),
        null,
      );

      await response.body?.cancel();
    }),
  );

  await waitFor(() => {
    expect(guest.requests).toHaveLength(64);
  });

  const reason = 'x'.repeat(20 * 1024);

  const large = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 2, reason },
      }),
    }),
    null,
  );

  expect(large.status).toBe(429);
  expect(guest.signals).toStrictEqual([]);
});

test('it ends a signed-in session with its DELETE with every slot held', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'box' });

  const boxImp = await findImpByName(ctx.db, 'box');

  invariant(boxImp);

  const boxAgent = await startStubExecAgent(
    buildImpPaths(ctx.dataDir, boxImp.id).vsockSocket,
    guest,
  );

  // closed before impd stops; its own fallback close then does nothing
  ctx.stack.defer(() => {
    boxAgent.close();
  });

  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.impd.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.impd.tokens.authenticate(made.secret);

  invariant(approver);

  const tokens = await runOAuthSignIn(
    {
      handle: (request) => ctx.handle(request, null),
      origin: 'http://127.0.0.1:7171',
      clientID: oauthClient.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read exec manage',
    },
    (code) => {
      ctx.impd.oauth.approve(ApprovalCodeSchema.parse(code), approver, 'exec', undefined);
    },
  );

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  // read to its end, as a client does, so it holds no slot
  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  // 64 long calls whose clients go away at once fill every slot

  await Promise.all(
    Array.from({ length: 64 }, async (_, offset) => {
      const response = await ctx.handle(
        new Request(`http://127.0.0.1:7171/mcp`, {
          method: 'POST',
          headers: {
            host: '127.0.0.1:7171',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${tokens.access_token}`,
            'mcp-session-id': mcpSession,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: offset + 1,
            method: 'tools/call',
            params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
          }),
        }),
        null,
      );

      await response.body?.cancel();
    }),
  );

  await waitFor(() => {
    expect(guest.requests).toHaveLength(64);
  });

  const ended = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'DELETE',
      headers: {
        host: '127.0.0.1:7171',
        authorization: `Bearer ${tokens.access_token}`,
        'mcp-session-id': mcpSession,
      },
    }),
    null,
  );

  expect(ended.status).toBe(204);
});
