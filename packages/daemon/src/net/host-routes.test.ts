import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubIpCommand } from '../test-utils/build-stub-ip-command';
import {
  parseConnectedPrefixes4,
  parseRouteDevice,
  parseUplinks,
  readConnectedPrefixes4,
  readRouteDevice,
  readUplinks,
} from './host-routes';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'imp-host-routes-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it reads the on-link IPv4 networks and every address off the taps', () => {
  const routes = [
    'default via 172.17.0.1 dev eth0',
    '10.66.0.0/30 dev imp0 proto kernel scope link src 10.66.0.1',
    '44.0.0.0/24 dev eth1 proto kernel scope link src 44.0.0.9',
    '172.17.0.0/16 dev eth0 proto kernel scope link src 172.17.0.2',
    '192.168.7.0/24 via 172.17.0.1 dev eth0',
    'blackhole 203.0.113.0/24',
    '198.18.5.7 dev wg0 scope link',
    '',
  ].join('\n');

  const addresses = [
    String.raw`1: lo    inet 127.0.0.1/8 scope host lo\       valid_lft forever preferred_lft forever`,
    String.raw`2: imp0    inet 10.66.0.1/30 scope global imp0\       valid_lft forever preferred_lft forever`,
    String.raw`3: eth0    inet 172.17.0.2/16 brd 172.17.255.255 scope global eth0\       valid_lft forever`,
    String.raw`4: eth1    inet 44.0.0.9/24 scope global eth1\       valid_lft forever preferred_lft forever`,
    String.raw`5: tailscale0    inet 100.101.102.103/32 scope global tailscale0\       valid_lft forever`,
  ].join('\n');

  expect(parseConnectedPrefixes4(routes, addresses)).toStrictEqual([
    '44.0.0.0/24',
    '172.17.0.0/16',
    '198.18.5.7/32',
    '127.0.0.0/8',
    '127.0.0.1/32',
    '172.17.0.2/32',
    '44.0.0.9/32',
    '100.101.102.103/32',
  ]);
});

test('it reads the connected IPv4 prefixes from the host routes and addresses', async () => {
  const ip = buildStubIpCommand({
    outputs: {
      'ip -4 route show': '172.17.0.0/16 dev eth0 proto kernel scope link src 172.17.0.2\n',
      'ip -4 -o addr show': String.raw`3: eth0    inet 172.17.0.2/16 scope global eth0\       valid_lft forever`,
    },
  });

  const prefixes = await readConnectedPrefixes4(ip.runChecked);

  expect(prefixes).toStrictEqual(['172.17.0.0/16', '172.17.0.2/32']);
});

test('it fails the connected prefix read when ip fails', () => {
  const ip = buildStubIpCommand({ failures: { 'ip -4 -o addr': 'Cannot open netlink socket' } });

  expect(readConnectedPrefixes4(ip.runChecked)).rejects.toThrowWithMessage(
    Error,
    'ip -4 -o addr show exited 2: Cannot open netlink socket',
  );
});

test("it reads the default routes' interfaces as the uplinks, never a tap", () => {
  const routes = [
    'default via 172.17.0.1 dev eth0',
    'default via fe80::1 dev eth0 metric 1024 pref medium',
    'default dev wg0 scope link',
    '172.17.0.0/16 dev eth0 proto kernel scope link src 172.17.0.2',
    'default via 10.66.0.1 dev imp0',
  ].join('\n');

  expect(parseUplinks(routes)).toStrictEqual(['eth0', 'wg0']);
});

test('it reads no uplinks from no routes', () => {
  expect(parseUplinks('')).toStrictEqual([]);
});

test("it reads a multipath default route's uplinks from its nexthop lines", () => {
  const routes = [
    'default proto ra metric 1024 expires 1797sec pref medium',
    '\tnexthop via fe80::1 dev eth0 weight 1',
    '\tnexthop via fe80::2 dev eth1 weight 1',
    '\tnexthop via fe80::3 dev imp4 weight 1',
    '2001:db8:1::/64 proto static metric 1024 pref medium',
    '\tnexthop via fe80::9 dev wg0 weight 1',
  ].join('\n');

  expect(parseUplinks(routes)).toStrictEqual(['eth0', 'eth1']);
});

test('it reads the uplinks of each family from the default routes', async () => {
  const ctx = await setupTest();

  const ip = buildStubIpCommand({
    outputs: {
      'ip -4 route show default': 'default via 172.17.0.1 dev eth0\n',
      'ip -6 route show default': 'default via fe80::1 dev eth1 metric 1024 pref medium\n',
    },
  });

  await mkdir(join(ctx.dir, 'ipv6'));

  const uplinks = await readUplinks(join(ctx.dir, 'ipv6'), ip.runChecked);

  expect(uplinks).toStrictEqual({ ipv4: ['eth0'], ipv6: ['eth1'] });
});

test('it reads no IPv6 uplinks, and runs no IPv6 read, on a kernel without IPv6', async () => {
  const ctx = await setupTest();

  const ip = buildStubIpCommand({
    outputs: { 'ip -4 route show default': 'default via 172.17.0.1 dev eth0\n' },
  });

  const uplinks = await readUplinks(join(ctx.dir, 'ipv6'), ip.runChecked);

  expect(uplinks).toStrictEqual({ ipv4: ['eth0'], ipv6: [] });
  expect(ip.calls).toStrictEqual(['ip -4 route show default']);
});

test.each([
  ['93.184.216.34 via 172.17.0.1 dev eth0 src 172.17.0.2 uid 0\n    cache\n', 'eth0'],
  ['local 172.17.0.2 dev lo table local src 172.17.0.2', 'lo'],
])('it reads the interface a route leaves by from %p', (route, dev) => {
  expect(parseRouteDevice(route, '93.184.216.34')).toBe(dev);
});

test('it rejects a route that names no interface', () => {
  expect(() =>
    parseRouteDevice('unreachable 203.0.113.9 table main', '203.0.113.9'),
  ).toThrowWithMessage(
    Error,
    'ip route get 203.0.113.9 named no interface: unreachable 203.0.113.9 table main',
  );
});

test('it asks ip which interface a route to the address leaves by', async () => {
  const ip = buildStubIpCommand({
    outputs: {
      'ip route get 93.184.216.34': '93.184.216.34 via 172.17.0.1 dev eth0 src 172.17.0.2\n',
    },
  });

  const dev = await readRouteDevice('93.184.216.34', ip.runChecked);

  expect(dev).toBe('eth0');
});
