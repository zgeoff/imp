import { expect, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { createEd25519Key } from '../ssh/host-key';
import { buildStubTailscale } from '../test-utils/build-stub-tailscale';
import { createTestDatabase } from '../test-utils/create-test-database';
import { createKnownHosts } from './ambient-request';
import { isSameOrigin, resolveCaller } from './authenticate';
import { buildSessionValue } from './session-cookie';
import { createTailnetIdentities, runWhois } from './tailnet-identity';
import { ROOT_TOKEN_ID, loadTokenStore } from './token-store';

async function setupTest() {
  const database = await createTestDatabase();

  return {
    // the token store over this database, as impd loads it
    loadTokens: (rootToken: string) =>
      loadTokenStore({
        db: database.db,
        rootToken,
        now: Date.now,
        onRemove: () => {},
        isFileKey: () => false,
      }),
  };
}

test('#resolveCaller takes the root token as root, from any origin', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const caller = await resolveCaller(
    new Request('http://imp:7070/rpc/imps/list', {
      method: 'POST',
      headers: { host: 'imp:7070', authorization: 'Bearer root-secret', origin: 'http://evil' },
    }),
    { tokens, rootToken: 'root-secret', now: Date.now, tailnet: null },
    { peer: null, cookie: true },
  );

  expect(caller).toStrictEqual({
    kind: 'token',
    name: 'root',
    scope: 'manage',
    imps: null,
    grantable: [],
    tokenId: ROOT_TOKEN_ID,
    grantId: null,
    expiresAt: null,
    principal: 'root',
    display: 'root',
  });
});

test('#resolveCaller takes a made token as itself, with its scope and imps', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');
  const made = await tokens.create({ name: 'ci', scope: 'exec', imps: ['dev-*'] });

  const [tokenId = ''] = made.secret.slice('imp_'.length).split('.');

  const caller = await resolveCaller(
    new Request('http://imp:7070/rpc/imps/list', {
      method: 'POST',
      headers: { host: 'imp:7070', authorization: `Bearer ${made.secret}` },
    }),
    { tokens, rootToken: 'root-secret', now: Date.now, tailnet: null },
    { peer: null, cookie: true },
  );

  expect(caller).toStrictEqual({
    kind: 'token',
    name: 'ci',
    scope: 'exec',
    imps: ['dev-*'],
    grantable: [],
    tokenId,
    grantId: null,
    expiresAt: null,
    principal: `token:${tokenId}`,
    display: 'ci',
  });
});

test('#resolveCaller makes a token, its dashboard session and its bound key one principal', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const line = `${createEd25519Key().public} me@laptop`;

  const made = await tokens.create({ name: 'ci', scope: 'exec', imps: null, sshKeys: [line] });

  const [tokenId = ''] = made.secret.slice('imp_'.length).split('.');
  const sources = { tokens, rootToken: 'root-secret', now: () => 1_800_000_000_000, tailnet: null };
  const session = buildSessionValue('root-secret', { tokenId, expiresAt: 1_800_000_060_000 });

  const [api, dashboard] = await Promise.all([
    resolveCaller(
      new Request('http://imp:7070/rpc/imps/list', {
        method: 'POST',
        headers: { host: 'imp:7070', authorization: `Bearer ${made.secret}` },
      }),
      sources,
      { peer: null, cookie: true },
    ),
    resolveCaller(
      new Request('http://imp:7070/rpc/imps/list', {
        method: 'POST',
        headers: {
          host: 'imp:7070',
          'sec-fetch-site': 'same-origin',
          cookie: `imp_session=${session}`,
        },
      }),
      sources,
      { peer: null, cookie: true },
    ),
  ]);

  const blob = Buffer.from(line.split(' ')[1] ?? '', 'base64');
  const ssh = tokens.findSshKey(blob)?.caller;

  expect(api).toMatchObject({ kind: 'token', principal: `token:${tokenId}`, display: 'ci' });

  expect(dashboard).toMatchObject({
    kind: 'dashboard',
    principal: `token:${tokenId}`,
    display: 'ci',
  });

  expect(ssh).toMatchObject({ kind: 'ssh', principal: `token:${tokenId}`, display: 'ci' });
});

test('#resolveCaller makes a new token under a removed token’s name another principal', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');
  const first = await tokens.create({ name: 'ci', scope: 'exec', imps: null });

  const [firstId = ''] = first.secret.slice('imp_'.length).split('.');

  await tokens.remove('ci');

  const again = await tokens.create({ name: 'ci', scope: 'exec', imps: null });

  const caller = await resolveCaller(
    new Request('http://imp:7070/rpc/imps/list', {
      method: 'POST',
      headers: { host: 'imp:7070', authorization: `Bearer ${again.secret}` },
    }),
    { tokens, rootToken: 'root-secret', now: Date.now, tailnet: null },
    { peer: null, cookie: true },
  );

  invariant(caller);

  expect(caller.principal).not.toBe(`token:${firstId}`);
});

test('#resolveCaller makes a root dashboard session the principal root', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const caller = await resolveCaller(
    new Request('http://imp:7070/rpc/imps/list', {
      method: 'POST',
      headers: {
        host: 'imp:7070',
        'sec-fetch-site': 'same-origin',
        cookie: `imp_session=${buildSessionValue('root-secret', { tokenId: ROOT_TOKEN_ID, expiresAt: 1_800_000_060_000 })}`,
      },
    }),
    { tokens, rootToken: 'root-secret', now: () => 1_800_000_000_000, tailnet: null },
    { peer: null, cookie: true },
  );

  expect(caller?.kind).toBe('dashboard');
  expect(caller?.principal).toBe('root');
});

test('#resolveCaller refuses a wrong bearer token, even with a valid session beside it', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const caller = await resolveCaller(
    new Request('http://imp:7070/rpc/imps/list', {
      method: 'POST',
      headers: {
        host: 'imp:7070',
        authorization: 'Bearer wrong',
        'sec-fetch-site': 'same-origin',
        cookie: `imp_session=${buildSessionValue('root-secret', { tokenId: ROOT_TOKEN_ID, expiresAt: 1_800_000_060_000 })}`,
      },
    }),
    { tokens, rootToken: 'root-secret', now: () => 1_800_000_000_000, tailnet: null },
    { peer: null, cookie: true },
  );

  expect(caller).toBeNull();
});

test('#resolveCaller takes a same-origin session as the dashboard, with its token’s scope and the session’s expiry', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');
  const made = await tokens.create({ name: 'viewer', scope: 'read', imps: null });

  const [tokenId = ''] = made.secret.slice('imp_'.length).split('.');

  const caller = await resolveCaller(
    new Request('http://imp:7070/rpc/imps/list', {
      method: 'POST',
      headers: {
        host: 'imp:7070',
        'sec-fetch-site': 'same-origin',
        cookie: `imp_session=${buildSessionValue('root-secret', { tokenId, expiresAt: 1_800_000_060_000 })}`,
      },
    }),
    { tokens, rootToken: 'root-secret', now: () => 1_800_000_000_000, tailnet: null },
    { peer: null, cookie: true },
  );

  expect(caller).toStrictEqual({
    kind: 'dashboard',
    name: 'viewer',
    scope: 'read',
    imps: null,
    grantable: [],
    tokenId,
    grantId: null,
    expiresAt: 1_800_000_060_000,
    principal: `token:${tokenId}`,
    display: 'viewer',
  });
});

test('#resolveCaller refuses a session at its expiry', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');
  const made = await tokens.create({ name: 'viewer', scope: 'read', imps: null });

  const [tokenId = ''] = made.secret.slice('imp_'.length).split('.');

  const caller = await resolveCaller(
    new Request('http://imp:7070/rpc/imps/list', {
      method: 'POST',
      headers: {
        host: 'imp:7070',
        'sec-fetch-site': 'same-origin',
        cookie: `imp_session=${buildSessionValue('root-secret', { tokenId, expiresAt: 1_800_000_060_000 })}`,
      },
    }),
    { tokens, rootToken: 'root-secret', now: () => 1_800_000_060_000, tailnet: null },
    { peer: null, cookie: true },
  );

  expect(caller).toBeNull();
});

test('#resolveCaller refuses a session whose token was removed', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');
  const made = await tokens.create({ name: 'viewer', scope: 'read', imps: null });

  const [tokenId = ''] = made.secret.slice('imp_'.length).split('.');

  await tokens.remove('viewer');

  const caller = await resolveCaller(
    new Request('http://imp:7070/rpc/imps/list', {
      method: 'POST',
      headers: {
        host: 'imp:7070',
        'sec-fetch-site': 'same-origin',
        cookie: `imp_session=${buildSessionValue('root-secret', { tokenId, expiresAt: 1_800_000_060_000 })}`,
      },
    }),
    { tokens, rootToken: 'root-secret', now: () => 1_800_000_000_000, tailnet: null },
    { peer: null, cookie: true },
  );

  expect(caller).toBeNull();
});

test('#resolveCaller refuses a v1 session from before named tokens', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const caller = await resolveCaller(
    new Request('http://imp:7070/rpc/imps/list', {
      method: 'POST',
      headers: {
        host: 'imp:7070',
        'sec-fetch-site': 'same-origin',
        cookie: 'imp_session=v1.1800000060000.c2lnbmF0dXJl',
      },
    }),
    { tokens, rootToken: 'root-secret', now: () => 1_800_000_000_000, tailnet: null },
    { peer: null, cookie: true },
  );

  expect(caller).toBeNull();
});

test('#resolveCaller finds the real session behind a bad one an imp planted first', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const caller = await resolveCaller(
    new Request('http://imp:7070/rpc/imps/list', {
      method: 'POST',
      headers: {
        host: 'imp:7070',
        'sec-fetch-site': 'same-origin',
        cookie: `imp_session=planted; imp_session=${buildSessionValue('root-secret', { tokenId: ROOT_TOKEN_ID, expiresAt: 1_800_000_060_000 })}`,
      },
    }),
    { tokens, rootToken: 'root-secret', now: () => 1_800_000_000_000, tailnet: null },
    { peer: null, cookie: true },
  );

  expect(caller?.kind).toBe('dashboard');
});

test('#resolveCaller refuses a session from another port of the same host', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const caller = await resolveCaller(
    new Request('http://imp:7070/rpc/imps/list', {
      method: 'POST',
      headers: {
        host: 'imp:7070',
        'sec-fetch-site': 'same-site',
        cookie: `imp_session=${buildSessionValue('root-secret', { tokenId: ROOT_TOKEN_ID, expiresAt: 1_800_000_060_000 })}`,
      },
    }),
    { tokens, rootToken: 'root-secret', now: () => 1_800_000_000_000, tailnet: null },
    { peer: null, cookie: true },
  );

  expect(caller).toBeNull();
});

test('#resolveCaller refuses a session where cookies do not count', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const caller = await resolveCaller(
    new Request('http://imp:7070/rpc/imps/list', {
      method: 'POST',
      headers: {
        host: 'imp:7070',
        'sec-fetch-site': 'same-origin',
        cookie: `imp_session=${buildSessionValue('root-secret', { tokenId: ROOT_TOKEN_ID, expiresAt: 1_800_000_060_000 })}`,
      },
    }),
    { tokens, rootToken: 'root-secret', now: () => 1_800_000_000_000, tailnet: null },
    { peer: null, cookie: false },
  );

  expect(caller).toBeNull();
});

test('#resolveCaller gives a tailnet peer that a rule matches the rule’s scope and imps', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const tailscale = buildStubTailscale();

  tailscale.registerPeer('100.101.102.103', { node: 'laptop', login: 'alice@example.com' });

  const caller = await resolveCaller(
    new Request('http://localhost:7070/rpc/imps/list', {
      method: 'POST',
      headers: { host: 'localhost:7070' },
    }),
    {
      tokens,
      rootToken: 'root-secret',
      now: Date.now,
      tailnet: {
        identities: createTailnetIdentities({
          rules: [{ match: 'user:alice@example.com', scope: 'read', imps: ['dev-*'] }],
          whois: (address) => runWhois(address, tailscale.run),
          readTailscale: tailscale.readTailscale,
          now: Date.now,
        }),
        knownHosts: createKnownHosts({ readTailscale: tailscale.readTailscale, domain: null }),
      },
    },
    { peer: '100.101.102.103', cookie: false },
  );

  expect(caller).toStrictEqual({
    kind: 'tailnet',
    name: 'alice@example.com',
    scope: 'read',
    imps: ['dev-*'],
    grantable: [],
    tokenId: null,
    grantId: null,
    expiresAt: null,
    principal: 'tailnet-user:alice@example.com',
    display: 'laptop',
  });
});

test('#resolveCaller refuses another user’s tailnet peer that no rule matches', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const tailscale = buildStubTailscale();

  tailscale.registerPeer('100.101.102.104', { node: 'desk', login: 'bob@example.com' });

  const caller = await resolveCaller(
    new Request('http://localhost:7070/rpc/imps/list', {
      method: 'POST',
      headers: { host: 'localhost:7070' },
    }),
    {
      tokens,
      rootToken: 'root-secret',
      now: Date.now,
      tailnet: {
        identities: createTailnetIdentities({
          rules: [{ match: 'user:alice@example.com', scope: 'read', imps: ['dev-*'] }],
          whois: (address) => runWhois(address, tailscale.run),
          readTailscale: tailscale.readTailscale,
          now: Date.now,
        }),
        knownHosts: createKnownHosts({ readTailscale: tailscale.readTailscale, domain: null }),
      },
    },
    { peer: '100.101.102.104', cookie: false },
  );

  expect(caller).toBeNull();
});

test('#resolveCaller refuses a tailnet peer when no rule gives the tailnet access', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const caller = await resolveCaller(
    new Request('http://localhost:7070/rpc/imps/list', {
      method: 'POST',
      headers: { host: 'localhost:7070' },
    }),
    { tokens, rootToken: 'root-secret', now: Date.now, tailnet: null },
    { peer: '100.101.102.103', cookie: false },
  );

  expect(caller).toBeNull();
});

test('#resolveCaller refuses a peer on the docker bridge, whatever whois says', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const tailscale = buildStubTailscale();

  tailscale.registerPeer('172.17.0.1', { node: 'laptop', login: 'alice@example.com' });

  const caller = await resolveCaller(
    new Request('http://localhost:7070/rpc/imps/list', {
      method: 'POST',
      headers: { host: 'localhost:7070' },
    }),
    {
      tokens,
      rootToken: 'root-secret',
      now: Date.now,
      tailnet: {
        identities: createTailnetIdentities({
          rules: [{ match: '*', scope: 'read' }],
          whois: (address) => runWhois(address, tailscale.run),
          readTailscale: tailscale.readTailscale,
          now: Date.now,
        }),
        knownHosts: createKnownHosts({ readTailscale: tailscale.readTailscale, domain: null }),
      },
    },
    { peer: '172.17.0.1', cookie: false },
  );

  expect(caller).toBeNull();
});

test('#resolveCaller refuses a request whose peer is unknown, with tailnet rules', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const tailscale = buildStubTailscale();

  const caller = await resolveCaller(
    new Request('http://localhost:7070/rpc/imps/list', {
      method: 'POST',
      headers: { host: 'localhost:7070' },
    }),
    {
      tokens,
      rootToken: 'root-secret',
      now: Date.now,
      tailnet: {
        identities: createTailnetIdentities({
          rules: [{ match: '*', scope: 'read' }],
          whois: (address) => runWhois(address, tailscale.run),
          readTailscale: tailscale.readTailscale,
          now: Date.now,
        }),
        knownHosts: createKnownHosts({ readTailscale: tailscale.readTailscale, domain: null }),
      },
    },
    { peer: null, cookie: false },
  );

  expect(caller).toBeNull();
});

test.each([
  [{ host: 'evil.example:7070', origin: 'http://evil.example:7070' }, 'with its origin'],
  [{ host: 'evil.example:7070' }, 'without an origin'],
])('#resolveCaller refuses a tailnet identity on a rebound host name, %p %s', async (headers) => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const tailscale = buildStubTailscale();

  tailscale.registerPeer('100.101.102.103', { node: 'laptop', login: 'alice@example.com' });

  const caller = await resolveCaller(
    new Request(`http://${headers.host}/rpc/imps/list`, { method: 'POST', headers }),
    {
      tokens,
      rootToken: 'root-secret',
      now: Date.now,
      tailnet: {
        identities: createTailnetIdentities({
          rules: [{ match: '*', scope: 'read' }],
          whois: (address) => runWhois(address, tailscale.run),
          readTailscale: tailscale.readTailscale,
          now: Date.now,
        }),
        knownHosts: createKnownHosts({ readTailscale: tailscale.readTailscale, domain: null }),
      },
    },
    { peer: '100.101.102.103', cookie: false },
  );

  expect(caller).toBeNull();
});

test.each([['imp:7070'], ['imp.tail1234.ts.net:7070'], ['100.64.0.1:7070'], ['imp.example.com']])(
  '#resolveCaller takes a tailnet identity on the known host %p',
  async (host) => {
    const ctx = await setupTest();
    const tokens = await ctx.loadTokens('root-secret');

    const tailscale = buildStubTailscale({
      status: {
        hostname: 'imp',
        dnsName: 'imp.tail1234.ts.net',
        ip: '100.64.0.1',
        ips: ['100.64.0.1'],
      },
    });

    tailscale.registerPeer('100.101.102.103', { node: 'laptop', login: 'alice@example.com' });

    const caller = await resolveCaller(
      new Request(`http://${host}/rpc/imps/list`, { method: 'POST', headers: { host } }),
      {
        tokens,
        rootToken: 'root-secret',
        now: Date.now,
        tailnet: {
          identities: createTailnetIdentities({
            rules: [{ match: '*', scope: 'read' }],
            whois: (address) => runWhois(address, tailscale.run),
            readTailscale: tailscale.readTailscale,
            now: Date.now,
          }),
          knownHosts: createKnownHosts({
            readTailscale: tailscale.readTailscale,
            domain: 'imp.example.com',
          }),
        },
      },
      { peer: '100.101.102.103', cookie: false },
    );

    expect(caller?.name).toBe('alice@example.com');
  },
);

test.each([
  [{ origin: 'http://localhost:20001', 'sec-fetch-site': 'same-site' }, 'with fetch metadata'],
  [{ origin: 'http://localhost:20001' }, 'without fetch metadata'],
])(
  '#resolveCaller refuses a tailnet identity to a page on an imp’s port, %p %s',
  async (headers) => {
    const ctx = await setupTest();
    const tokens = await ctx.loadTokens('root-secret');

    const tailscale = buildStubTailscale();

    tailscale.registerPeer('100.101.102.103', { node: 'laptop', login: 'alice@example.com' });

    const caller = await resolveCaller(
      new Request('http://localhost:7070/rpc/imps/list', {
        method: 'POST',
        headers: { host: 'localhost:7070', ...headers },
      }),
      {
        tokens,
        rootToken: 'root-secret',
        now: Date.now,
        tailnet: {
          identities: createTailnetIdentities({
            rules: [{ match: '*', scope: 'read' }],
            whois: (address) => runWhois(address, tailscale.run),
            readTailscale: tailscale.readTailscale,
            now: Date.now,
          }),
          knownHosts: createKnownHosts({ readTailscale: tailscale.readTailscale, domain: null }),
        },
      },
      { peer: '100.101.102.103', cookie: false },
    );

    expect(caller).toBeNull();
  },
);

test('#resolveCaller takes a tailnet identity from the dashboard’s own page', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const tailscale = buildStubTailscale();

  tailscale.registerPeer('100.101.102.103', { node: 'laptop', login: 'alice@example.com' });

  const caller = await resolveCaller(
    new Request('http://localhost:7070/rpc/imps/list', {
      method: 'POST',
      headers: {
        host: 'localhost:7070',
        origin: 'http://localhost:7070',
        'sec-fetch-site': 'same-origin',
      },
    }),
    {
      tokens,
      rootToken: 'root-secret',
      now: Date.now,
      tailnet: {
        identities: createTailnetIdentities({
          rules: [{ match: '*', scope: 'read' }],
          whois: (address) => runWhois(address, tailscale.run),
          readTailscale: tailscale.readTailscale,
          now: Date.now,
        }),
        knownHosts: createKnownHosts({ readTailscale: tailscale.readTailscale, domain: null }),
      },
    },
    { peer: '100.101.102.103', cookie: false },
  );

  expect(caller?.kind).toBe('tailnet');
});

test.each([
  ['http://imp:7070', true],
  ['https://imp:7070', true],
  ['http://imp:20001', false],
  ['http://other:7070', false],
  ['null', false],
  ['not a url', false],
])('#isSameOrigin without fetch metadata answers the origin %p with %p', (origin, same) => {
  const request = new Request('http://imp:7070/rpc/imps/list', {
    method: 'POST',
    headers: { host: 'imp:7070', origin },
  });

  expect(isSameOrigin(request)).toBe(same);
});

test('#isSameOrigin refuses a request with no origin and no fetch metadata', () => {
  const request = new Request('http://imp:7070/rpc/imps/list', {
    method: 'POST',
    headers: { host: 'imp:7070' },
  });

  expect(isSameOrigin(request)).toBeFalse();
});

test('#isSameOrigin lets fetch metadata win over a matching origin', () => {
  const request = new Request('http://imp:7070/rpc/imps/list', {
    method: 'POST',
    headers: { host: 'imp:7070', origin: 'http://imp:7070', 'sec-fetch-site': 'cross-site' },
  });

  expect(isSameOrigin(request)).toBeFalse();
});
