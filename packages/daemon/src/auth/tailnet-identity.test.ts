import { expect, test } from 'bun:test';
import type { TailscaleStatus } from '../net/tailscale-status';
import {
  TailnetRulesSchema,
  createTailnetIdentities,
  findTailnetCaller,
  isTailnetAddress,
  parseWhois,
} from './tailnet-identity';
import type { TailnetPeer } from './tailnet-identity';

const ALICE: TailnetPeer = { login: 'alice@example.com', tags: [], node: 'laptop' };
const CI: TailnetPeer = { login: null, tags: ['tag:ci'], node: 'runner' };

// the node impd runs on
const NODE_STATUS: TailscaleStatus = {
  state: 'Running',
  hostname: 'imp-1',
  dnsName: 'imp-1.tail1234.ts.net',
  ip: '100.64.0.7',
  ips: ['100.64.0.7', 'fd7a:115c:a1e0::7'],
};

function readNodeStatus(): Promise<TailscaleStatus> {
  return Promise.resolve(NODE_STATUS);
}

// trimmed from `tailscale whois --json` for a user's node and a tagged one
const USER_WHOIS = JSON.stringify({
  Node: { ID: 1, Name: 'laptop.tail1234.ts.net.', Addresses: ['100.101.102.103/32'] },
  UserProfile: { ID: 2, LoginName: 'alice@example.com', DisplayName: 'Alice' },
  CapMap: {},
});

const TAGGED_WHOIS = JSON.stringify({
  Node: { ID: 3, Name: 'runner.tail1234.ts.net.', Tags: ['tag:ci'] },
  UserProfile: { ID: 4, LoginName: 'tagged-devices', DisplayName: 'Tagged Devices' },
});

test('it reads a user’s node and a tagged node from whois', () => {
  expect(parseWhois(USER_WHOIS)).toEqual(ALICE);
  expect(parseWhois(TAGGED_WHOIS)).toEqual(CI);
  expect(parseWhois('')).toBeNull();
  expect(parseWhois('{"Node":{}}')).toBeNull();
});

test('the first rule that matches gives the scope; a tagged node matches by tag only', () => {
  const rules = TailnetRulesSchema.parse([
    { match: 'tag:ci', scope: 'exec', imps: ['ci-*'] },
    { match: 'user:alice@example.com', scope: 'manage' },
    { match: 'user:tagged-devices', scope: 'manage' },
  ]);

  expect(findTailnetCaller(rules, ALICE)).toMatchObject({
    kind: 'tailnet',
    name: 'alice@example.com',
    scope: 'manage',
    imps: null,
  });

  expect(findTailnetCaller(rules, CI)).toMatchObject({ name: 'runner', scope: 'exec' });
  expect(findTailnetCaller(rules.slice(2), CI)).toBeNull();
  expect(findTailnetCaller([{ match: '*', scope: 'read' }], CI)).toMatchObject({ scope: 'read' });
});

test('rules must be well formed', () => {
  expect(TailnetRulesSchema.safeParse([]).success).toBeFalse();
  expect(TailnetRulesSchema.safeParse([{ match: 'alice', scope: 'read' }]).success).toBeFalse();
  expect(TailnetRulesSchema.safeParse([{ match: '*', scope: 'root' }]).success).toBeFalse();
});

test('only Tailscale’s ranges are tailnet addresses', () => {
  expect(isTailnetAddress('100.64.0.1')).toBeTrue();
  expect(isTailnetAddress('100.127.255.254')).toBeTrue();
  expect(isTailnetAddress('::ffff:100.101.102.103')).toBeTrue();
  expect(isTailnetAddress('fd7a:115c:a1e0::1')).toBeTrue();
  expect(isTailnetAddress('100.128.0.1')).toBeFalse();
  expect(isTailnetAddress('100.63.255.255')).toBeFalse();
  expect(isTailnetAddress('127.0.0.1')).toBeFalse();
  expect(isTailnetAddress('10.66.0.2')).toBeFalse();
  expect(isTailnetAddress('fd7a:115c:a1e1::1')).toBeFalse();
});

test('whois answers are kept a minute, and never asked for other addresses', async () => {
  const clock = { at: 0 };
  const asked: string[] = [];

  const identities = createTailnetIdentities({
    rules: [{ match: 'user:alice@example.com', scope: 'read' }],
    whois: (address) => {
      asked.push(address);

      return Promise.resolve(ALICE);
    },
    readTailscale: readNodeStatus,
    now: () => clock.at,
  });

  await identities.resolve('100.101.102.103');
  await identities.resolve('::ffff:100.101.102.103');
  await identities.resolve('192.168.1.5');

  clock.at += 60_000;

  await identities.resolve('100.101.102.103');

  expect(asked).toEqual(['100.101.102.103', '100.101.102.103']);
});

test('a failed whois gives no identity', async () => {
  const identities = createTailnetIdentities({
    rules: [{ match: '*', scope: 'read' }],
    whois: () => Promise.reject(new Error('tailscaled is down')),
    readTailscale: readNodeStatus,
    now: () => 0,
  });

  const caller = await identities.resolve('100.101.102.103');

  expect(caller).toBeNull();
});

test('the node’s own addresses are no peer, whatever whois says', async () => {
  const asked: string[] = [];

  const identities = createTailnetIdentities({
    rules: [{ match: '*', scope: 'manage' }],
    whois: (address) => {
      asked.push(address);

      return Promise.resolve({ login: null, tags: ['tag:imp'], node: 'imp-1' });
    },
    readTailscale: readNodeStatus,
    now: () => 0,
  });

  const [ipv4, mapped, ipv6, other] = await Promise.all([
    identities.resolve('100.64.0.7'),
    identities.resolve('::ffff:100.64.0.7'),
    identities.resolve('FD7A:115C:A1E0::7'),
    identities.resolve('100.101.102.103'),
  ]);

  expect([ipv4, mapped, ipv6]).toEqual([null, null, null]);
  expect(other?.name).toBe('imp-1');
  expect(asked).toEqual(['100.101.102.103']);
});
