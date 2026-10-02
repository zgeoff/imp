import { expect, test } from 'bun:test';
import { setupTestDatabase } from '../db/test-database';
import { createKnownHosts } from './ambient-request';
import { isSameOrigin, resolveCaller } from './authenticate';
import type { CallerSources } from './authenticate';
import { buildSessionValue } from './session-cookie';
import { createTailnetIdentities } from './tailnet-identity';
import type { TailnetPeer } from './tailnet-identity';
import { ROOT_TOKEN_ID, loadTokenStore } from './token-store';

const NOW = 1_800_000_000_000;
const ROOT = 'root-secret';
const TAILNET_PEER = '100.101.102.103';
const ALICE: TailnetPeer = { login: 'alice@example.com', tags: [], node: 'laptop' };

const FAKE_STATUS = {
  state: 'Running',
  hostname: 'imp',
  dnsName: 'imp.tail1234.ts.net',
  ip: '100.64.0.1',
  ips: ['100.64.0.1'],
};

// alice's laptop is the one tailnet peer; her rule gives read on dev-*
function buildTailnet() {
  const peers = new Map([[TAILNET_PEER, ALICE]]);

  return {
    identities: createTailnetIdentities({
      rules: [{ match: 'user:alice@example.com', scope: 'read', imps: ['dev-*'] }],
      whois: (address) => Promise.resolve(peers.get(address) ?? null),
      readTailscale: () => Promise.resolve(FAKE_STATUS),
      now: () => NOW,
    }),
    knownHosts: createKnownHosts({
      readTailscale: () => Promise.resolve(FAKE_STATUS),
      domain: 'imp.example.com',
    }),
  };
}

async function setupTest(tailnet = false) {
  const database = await setupTestDatabase();

  const tokens = await loadTokenStore({
    db: database.db,
    rootToken: ROOT,
    now: () => NOW,
    onRemove: () => {},
    isFileKey: () => false,
  });

  const sources: CallerSources = {
    tokens,
    rootToken: ROOT,
    now: () => NOW,
    tailnet: tailnet ? buildTailnet() : null,
  };

  const buildSession = (tokenId: string) =>
    `imp_session=${buildSessionValue(ROOT, { tokenId, expiresAt: NOW + 60_000 })}`;

  return { ...database, tokens, sources, buildSession };
}

function buildRequest(headers: Readonly<Record<string, string>>, host = 'imp:7070'): Request {
  return new Request(`http://${host}/rpc/imps/list`, {
    method: 'POST',
    headers: { host, ...headers },
  });
}

const BY_TOKEN = { peer: null, cookie: true } as const;

test('the root token is a token with every scope, from anywhere, for good', async () => {
  await using ctx = await setupTest();

  const request = buildRequest({ authorization: `Bearer ${ROOT}`, origin: 'http://evil' });

  const caller = await resolveCaller(request, ctx.sources, BY_TOKEN);

  expect(caller).toEqual({
    kind: 'token',
    name: 'root',
    scope: 'manage',
    imps: null,
    tokenId: ROOT_TOKEN_ID,
    expiresAt: null,
  });
});

test('a made token is itself, with its scope and imps', async () => {
  await using ctx = await setupTest();

  const made = await ctx.tokens.create({ name: 'ci', scope: 'exec', imps: ['dev-*'] });

  const request = buildRequest({ authorization: `Bearer ${made.secret}` });

  const caller = await resolveCaller(request, ctx.sources, BY_TOKEN);

  expect(caller).toMatchObject({
    kind: 'token',
    name: 'ci',
    scope: 'exec',
    imps: ['dev-*'],
  });
});

test('a wrong bearer token is refused, even with a valid session beside it', async () => {
  await using ctx = await setupTest();

  const request = buildRequest({
    authorization: 'Bearer wrong',
    cookie: ctx.buildSession(ROOT_TOKEN_ID),
    'sec-fetch-site': 'same-origin',
  });

  const caller = await resolveCaller(request, ctx.sources, BY_TOKEN);

  expect(caller).toBeNull();
});

test('a same-origin session is the dashboard, with its token’s scope, until it expires', async () => {
  await using ctx = await setupTest();

  const made = await ctx.tokens.create({ name: 'viewer', scope: 'read', imps: null });

  const tokenId = ctx.tokens.authenticate(made.secret)?.tokenId ?? '';

  const request = buildRequest({
    cookie: ctx.buildSession(tokenId),
    'sec-fetch-site': 'same-origin',
  });

  const caller = await resolveCaller(request, ctx.sources, BY_TOKEN);

  expect(caller).toMatchObject({
    kind: 'dashboard',
    name: 'viewer',
    scope: 'read',
    expiresAt: NOW + 60_000,
  });

  const later = { ...ctx.sources, now: () => NOW + 60_000 };

  const expired = await resolveCaller(request, later, BY_TOKEN);

  expect(expired).toBeNull();
});

test('a session ends when its token is removed', async () => {
  await using ctx = await setupTest();

  const made = await ctx.tokens.create({ name: 'viewer', scope: 'read', imps: null });

  const tokenId = ctx.tokens.authenticate(made.secret)?.tokenId ?? '';

  const request = buildRequest({
    cookie: ctx.buildSession(tokenId),
    'sec-fetch-site': 'same-origin',
  });

  await ctx.tokens.remove('viewer');

  const caller = await resolveCaller(request, ctx.sources, BY_TOKEN);

  expect(caller).toBeNull();
});

test('a v1 session from before named tokens logs nobody in', async () => {
  await using ctx = await setupTest();

  const request = buildRequest({
    cookie: `imp_session=v1.${String(NOW + 60_000)}.c2lnbmF0dXJl`,
    'sec-fetch-site': 'same-origin',
  });

  const caller = await resolveCaller(request, ctx.sources, BY_TOKEN);

  expect(caller).toBeNull();
});

test('a bad session cookie an imp planted first does not hide the real one', async () => {
  await using ctx = await setupTest();

  const request = buildRequest({
    cookie: `imp_session=planted; ${ctx.buildSession(ROOT_TOKEN_ID)}`,
    'sec-fetch-site': 'same-origin',
  });

  const caller = await resolveCaller(request, ctx.sources, BY_TOKEN);

  expect(caller).not.toBeNull();
});

test('it refuses the session from another port of the same host, or where cookies do not count', async () => {
  await using ctx = await setupTest();

  const crossPort = buildRequest({
    cookie: ctx.buildSession(ROOT_TOKEN_ID),
    'sec-fetch-site': 'same-site',
  });

  const sameOrigin = buildRequest({
    cookie: ctx.buildSession(ROOT_TOKEN_ID),
    'sec-fetch-site': 'same-origin',
  });

  const fromCrossPort = await resolveCaller(crossPort, ctx.sources, BY_TOKEN);

  const withoutCookies = await resolveCaller(sameOrigin, ctx.sources, {
    peer: null,
    cookie: false,
  });

  expect(fromCrossPort).toBeNull();
  expect(withoutCookies).toBeNull();
});

test('a tailnet peer that a rule matches gets the rule’s scope and imps', async () => {
  await using ctx = await setupTest(true);

  const caller = await resolveCaller(buildRequest({}), ctx.sources, {
    peer: TAILNET_PEER,
    cookie: false,
  });

  expect(caller).toEqual({
    kind: 'tailnet',
    name: 'alice@example.com',
    scope: 'read',
    imps: ['dev-*'],
    tokenId: null,
    expiresAt: null,
  });
});

test('a tailnet identity needs a tailnet address, and rules', async () => {
  await using off = await setupTest(false);
  await using on = await setupTest(true);

  const options = { peer: TAILNET_PEER, cookie: false };

  const withoutRules = await resolveCaller(buildRequest({}), off.sources, options);

  // a peer on the docker bridge is no tailnet peer, whatever whois says
  const bridge = { peer: '172.17.0.1', cookie: false };

  const fromBridge = await resolveCaller(buildRequest({}), on.sources, bridge);

  expect(withoutRules).toBeNull();
  expect(fromBridge).toBeNull();
});

test('a tailnet identity is refused on a rebound host name', async () => {
  await using ctx = await setupTest(true);

  const options = { peer: TAILNET_PEER, cookie: false };

  // a page on evil.example whose name now resolves to impd's address
  const rebound = buildRequest({ origin: 'http://evil.example:7070' }, 'evil.example:7070');
  const sameNameNoOrigin = buildRequest({}, 'evil.example:7070');

  const fromRebound = await resolveCaller(rebound, ctx.sources, options);
  const fromReboundName = await resolveCaller(sameNameNoOrigin, ctx.sources, options);

  expect(fromRebound).toBeNull();
  expect(fromReboundName).toBeNull();

  const known = ['imp:7070', 'imp.tail1234.ts.net:7070', '100.64.0.1:7070', 'imp.example.com'];

  const callers = await Promise.all(
    known.map((host) => resolveCaller(buildRequest({}, host), ctx.sources, options)),
  );

  expect(callers.map((caller) => caller?.name)).toEqual(known.map(() => 'alice@example.com'));
});

test('a tailnet identity is refused to a page on an imp’s port', async () => {
  await using ctx = await setupTest(true);

  const options = { peer: TAILNET_PEER, cookie: false };
  const fromImpPage = buildRequest({ origin: 'http://imp:20001', 'sec-fetch-site': 'same-site' });
  const fromImpNoMetadata = buildRequest({ origin: 'http://imp:20001' });

  const fromDashboard = buildRequest({
    origin: 'http://imp:7070',
    'sec-fetch-site': 'same-origin',
  });

  const callers = await Promise.all(
    [fromImpPage, fromImpNoMetadata, fromDashboard].map((request) =>
      resolveCaller(request, ctx.sources, options),
    ),
  );

  expect(callers.map((caller) => caller?.kind ?? null)).toEqual([null, null, 'tailnet']);
});

test('without fetch metadata it needs an origin naming this host and port', () => {
  expect(isSameOrigin(buildRequest({ origin: 'http://imp:7070' }))).toBe(true);

  // the scheme may differ behind a TLS front
  expect(isSameOrigin(buildRequest({ origin: 'https://imp:7070' }))).toBe(true);
  expect(isSameOrigin(buildRequest({ origin: 'http://imp:20001' }))).toBe(false);
  expect(isSameOrigin(buildRequest({ origin: 'http://other:7070' }))).toBe(false);
  expect(isSameOrigin(buildRequest({ origin: 'null' }))).toBe(false);
  expect(isSameOrigin(buildRequest({}))).toBe(false);
});

test('fetch metadata wins over a matching origin', () => {
  const request = buildRequest({ origin: 'http://imp:7070', 'sec-fetch-site': 'cross-site' });

  expect(isSameOrigin(request)).toBe(false);
});
