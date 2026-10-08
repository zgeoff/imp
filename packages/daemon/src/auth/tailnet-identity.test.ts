import { expect, test } from 'bun:test';
import { buildStubTailscale } from '../test-utils/build-stub-tailscale';
import {
  TailnetRulesSchema,
  createTailnetIdentities,
  findTailnetCaller,
  isTailnetAddress,
  parseWhois,
  runWhois,
} from './tailnet-identity';

// trimmed from `tailscale whois --json`, for a user's node and a tagged one
test('#parseWhois reads a user’s node', () => {
  const json = JSON.stringify({
    Node: { ID: 1, Name: 'laptop.tail1234.ts.net.', Addresses: ['100.101.102.103/32'] },
    UserProfile: { ID: 2, LoginName: 'alice@example.com', DisplayName: 'Alice' },
    CapMap: {},
  });

  expect(parseWhois(json)).toStrictEqual({
    login: 'alice@example.com',
    tags: [],
    node: 'laptop',
    stableId: null,
  });
});

test('#parseWhois reads a tagged node by its tags, with no user', () => {
  const json = JSON.stringify({
    Node: { ID: 3, StableID: 'nRunner1CNTRL', Name: 'runner.tail1234.ts.net.', Tags: ['tag:ci'] },
    UserProfile: { ID: 4, LoginName: 'tagged-devices', DisplayName: 'Tagged Devices' },
  });

  expect(parseWhois(json)).toStrictEqual({
    login: null,
    tags: ['tag:ci'],
    node: 'runner',
    stableId: 'nRunner1CNTRL',
  });
});

test('#parseWhois reads an empty StableID as none, not a broken answer', () => {
  const json = JSON.stringify({
    Node: { ID: 3, StableID: '', Name: 'runner.tail1234.ts.net.', Tags: ['tag:ci'] },
    UserProfile: { ID: 4, LoginName: 'tagged-devices', DisplayName: 'Tagged Devices' },
  });

  expect(parseWhois(json)).toStrictEqual({
    login: null,
    tags: ['tag:ci'],
    node: 'runner',
    stableId: null,
  });
});

test.each([[''], ['{"Node":{}}'], ['not json']])('#parseWhois reads no peer from %p', (json) => {
  expect(parseWhois(json)).toBeNull();
});

test('#runWhois reads the peer behind an address from tailscale whois', async () => {
  const tailscale = buildStubTailscale();

  tailscale.registerPeer('100.101.102.103', { node: 'laptop', login: 'alice@example.com' });

  const peer = await runWhois('100.101.102.103', tailscale.run);

  expect(peer).toStrictEqual({
    login: 'alice@example.com',
    tags: [],
    node: 'laptop',
    stableId: null,
  });
});

test('#runWhois reads no peer when tailscale whois fails for the address', async () => {
  const tailscale = buildStubTailscale();

  const peer = await runWhois('100.101.102.103', tailscale.run);

  expect(peer).toBeNull();
});

test('#findTailnetCaller gives a user the first rule that matches it', () => {
  const caller = findTailnetCaller(
    [
      { match: 'tag:ci', scope: 'exec', imps: ['ci-*'] },
      { match: 'user:alice@example.com', scope: 'manage' },
      { match: '*', scope: 'read' },
    ],
    { login: 'alice@example.com', tags: [], node: 'laptop', stableId: null },
  );

  expect(caller).toStrictEqual({
    kind: 'tailnet',
    name: 'alice@example.com',
    scope: 'manage',
    imps: null,
    grantable: [],
    tokenId: null,
    grantId: null,
    expiresAt: null,
    principal: 'tailnet-user:alice@example.com',
    display: 'laptop',
  });
});

test('#findTailnetCaller gives a tagged node its tag’s rule, named by its node and owning by its stable ID', () => {
  const caller = findTailnetCaller(
    [
      { match: 'user:alice@example.com', scope: 'manage' },
      { match: 'tag:ci', scope: 'exec', imps: ['ci-*'] },
    ],
    { login: null, tags: ['tag:ci'], node: 'runner', stableId: 'nRunner1CNTRL' },
  );

  expect(caller).toStrictEqual({
    kind: 'tailnet',
    name: 'runner',
    scope: 'exec',
    imps: ['ci-*'],
    grantable: [],
    tokenId: null,
    grantId: null,
    expiresAt: null,
    principal: 'tailnet:nRunner1CNTRL',
    display: 'runner',
  });
});

test('#findTailnetCaller gives a tagged node without a stable ID no principal, so no leases, and shows its node', () => {
  const caller = findTailnetCaller([{ match: '*', scope: 'exec' }], {
    login: null,
    tags: ['tag:ci'],
    node: 'runner',
    stableId: null,
  });

  expect(caller).toStrictEqual({
    kind: 'tailnet',
    name: 'runner',
    scope: 'exec',
    imps: null,
    grantable: [],
    tokenId: null,
    grantId: null,
    expiresAt: null,
    principal: null,
    display: 'runner',
  });
});

test('#findTailnetCaller matches a tagged node by its tags only, never its placeholder user', () => {
  const caller = findTailnetCaller([{ match: 'user:tagged-devices', scope: 'manage' }], {
    login: null,
    tags: ['tag:ci'],
    node: 'runner',
    stableId: 'nRunner1CNTRL',
  });

  expect(caller).toBeNull();
});

test('#findTailnetCaller refuses another user no rule matches', () => {
  const caller = findTailnetCaller([{ match: 'user:alice@example.com', scope: 'manage' }], {
    login: 'bob@example.com',
    tags: [],
    node: 'desk',
    stableId: null,
  });

  expect(caller).toBeNull();
});

test('#findTailnetCaller lets * match any peer', () => {
  const caller = findTailnetCaller([{ match: '*', scope: 'read' }], {
    login: null,
    tags: ['tag:ci'],
    node: 'runner',
    stableId: 'nRunner1CNTRL',
  });

  expect(caller?.scope).toBe('read');
});

test('#TailnetRulesSchema accepts user, tag and * rules', () => {
  const payload = [
    { match: 'user:alice@example.com', scope: 'manage' },
    { match: 'tag:ci', scope: 'exec', imps: ['ci-*'] },
    { match: '*', scope: 'read' },
  ] as const;

  const result = TailnetRulesSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#TailnetRulesSchema rejects an empty list', () => {
  const result = TailnetRulesSchema.safeParse([]);

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'too_small' });
});

test('#TailnetRulesSchema rejects a match that is no user, tag or *', () => {
  const result = TailnetRulesSchema.safeParse([{ match: 'alice', scope: 'read', imps: ['dev-*'] }]);

  expect(result.error?.issues).toPartiallyContain({ path: [0, 'match'], code: 'invalid_format' });
});

test('#TailnetRulesSchema rejects a scope that does not exist', () => {
  const result = TailnetRulesSchema.safeParse([{ match: '*', scope: 'root', imps: ['dev-*'] }]);

  expect(result.error?.issues).toPartiallyContain({ path: [0, 'scope'], code: 'invalid_value' });
});

test('#TailnetRulesSchema rejects an empty imps list', () => {
  const result = TailnetRulesSchema.safeParse([{ match: '*', scope: 'read', imps: [] }]);

  expect(result.error?.issues).toPartiallyContain({ path: [0, 'imps'], code: 'too_small' });
});

test.each([
  ['100.64.0.1', true],
  ['100.127.255.254', true],
  ['::ffff:100.101.102.103', true],
  ['fd7a:115c:a1e0::1', true],
  ['FD7A:115C:A1E0::1', true],
  ['100.128.0.1', false],
  ['100.63.255.255', false],
  ['127.0.0.1', false],
  ['10.66.0.2', false],
  ['fd7a:115c:a1e1::1', false],
])('#isTailnetAddress answers %p with %p', (address, isTailnet) => {
  expect(isTailnetAddress(address)).toBe(isTailnet);
});

test('#resolve gives the caller of the rule that matches the peer behind an address', async () => {
  const tailscale = buildStubTailscale();

  tailscale.registerPeer('100.101.102.103', { node: 'laptop', login: 'alice@example.com' });

  const identities = createTailnetIdentities({
    rules: [{ match: 'user:alice@example.com', scope: 'read', imps: ['dev-*'] }],
    whois: (address) => runWhois(address, tailscale.run),
    readTailscale: tailscale.readTailscale,
    now: () => 0,
  });

  const caller = await identities.resolve('100.101.102.103');

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

test('#resolve refuses another user whose peer no rule matches', async () => {
  const tailscale = buildStubTailscale();

  tailscale.registerPeer('100.101.102.104', { node: 'desk', login: 'bob@example.com' });

  const identities = createTailnetIdentities({
    rules: [{ match: 'user:alice@example.com', scope: 'read' }],
    whois: (address) => runWhois(address, tailscale.run),
    readTailscale: tailscale.readTailscale,
    now: () => 0,
  });

  const caller = await identities.resolve('100.101.102.104');

  expect(caller).toBeNull();
});

test('#resolve asks whois once a minute per address, and never for an address off the tailnet', async () => {
  const clock = { at: 0 };
  const tailscale = buildStubTailscale();

  tailscale.registerPeer('100.101.102.103', { node: 'laptop', login: 'alice@example.com' });

  const identities = createTailnetIdentities({
    rules: [{ match: 'user:alice@example.com', scope: 'read' }],
    whois: (address) => runWhois(address, tailscale.run),
    readTailscale: tailscale.readTailscale,
    now: () => clock.at,
  });

  await identities.resolve('100.101.102.103');
  await identities.resolve('::ffff:100.101.102.103');
  await identities.resolve('192.168.1.5');

  clock.at += 60_000;

  await identities.resolve('100.101.102.103');

  expect(tailscale.asked).toStrictEqual(['100.101.102.103', '100.101.102.103']);
});

test('#resolve forgets the oldest of 256 cached answers when another address comes', async () => {
  const tailscale = buildStubTailscale();

  const identities = createTailnetIdentities({
    rules: [{ match: '*', scope: 'read' }],
    whois: (address) => runWhois(address, tailscale.run),
    readTailscale: tailscale.readTailscale,
    now: () => 0,
  });

  // 257 addresses fill the cache past its 256 answers
  for (let index = 0; index < 257; index += 1) {
    await identities.resolve(
      `100.100.${String(Math.floor(index / 250))}.${String((index % 250) + 1)}`,
    );
  }

  await identities.resolve('100.100.0.1');

  expect(tailscale.asked.filter((address) => address === '100.100.0.1')).toHaveLength(2);
});

test('#resolve keeps a newer cached answer when the cache forgets the oldest', async () => {
  const tailscale = buildStubTailscale();

  const identities = createTailnetIdentities({
    rules: [{ match: '*', scope: 'read' }],
    whois: (address) => runWhois(address, tailscale.run),
    readTailscale: tailscale.readTailscale,
    now: () => 0,
  });

  // 257 addresses fill the cache past its 256 answers
  for (let index = 0; index < 257; index += 1) {
    await identities.resolve(
      `100.100.${String(Math.floor(index / 250))}.${String((index % 250) + 1)}`,
    );
  }

  await identities.resolve('100.100.0.2');

  expect(tailscale.asked.filter((address) => address === '100.100.0.2')).toHaveLength(1);
});

test('#resolve gives no identity when whois fails, as with tailscaled down', async () => {
  const tailscale = buildStubTailscale();

  const identities = createTailnetIdentities({
    rules: [{ match: '*', scope: 'read' }],
    whois: () => Promise.reject(new Error('tailscaled is down')),
    readTailscale: tailscale.readTailscale,
    now: () => 0,
  });

  const caller = await identities.resolve('100.101.102.103');

  expect(caller).toBeNull();
});

test.each([['100.64.0.7'], ['::ffff:100.64.0.7'], ['FD7A:115C:A1E0::7']])(
  '#resolve takes the node’s own address %p for no peer, whatever whois says',
  async (address) => {
    const tailscale = buildStubTailscale({
      status: { ip: '100.64.0.7', ips: ['100.64.0.7', 'fd7a:115c:a1e0::7'] },
    });

    tailscale.registerPeer('100.64.0.7', { node: 'imp-1', login: null, tags: ['tag:imp'] });

    const identities = createTailnetIdentities({
      rules: [{ match: '*', scope: 'manage' }],
      whois: (peer) => runWhois(peer, tailscale.run),
      readTailscale: tailscale.readTailscale,
      now: () => 0,
    });

    const caller = await identities.resolve(address);

    expect(caller).toBeNull();
    expect(tailscale.asked).toStrictEqual([]);
  },
);

test('#resolve asks whois for a peer beside the node, as the control for its own addresses', async () => {
  const tailscale = buildStubTailscale({
    status: { ip: '100.64.0.7', ips: ['100.64.0.7', 'fd7a:115c:a1e0::7'] },
  });

  tailscale.registerPeer('100.101.102.103', { node: 'laptop', login: null, tags: ['tag:ci'] });

  const identities = createTailnetIdentities({
    rules: [{ match: '*', scope: 'manage' }],
    whois: (peer) => runWhois(peer, tailscale.run),
    readTailscale: tailscale.readTailscale,
    now: () => 0,
  });

  const caller = await identities.resolve('100.101.102.103');

  expect(caller?.name).toBe('laptop');
  expect(tailscale.asked).toStrictEqual(['100.101.102.103']);
});
