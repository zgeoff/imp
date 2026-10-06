import { expect, test } from 'bun:test';
import { parseConnectedPrefixes4, parseRouteDevice, parseUplinks } from './host-routes';

test('the IPv4 networks on the links, and every address, off the taps', () => {
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

  expect(parseConnectedPrefixes4(routes, addresses)).toEqual([
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

test('the uplinks are the default routes’ interfaces, in each family, never a tap', () => {
  const routes = [
    'default via 172.17.0.1 dev eth0',
    'default via fe80::1 dev eth0 metric 1024 pref medium',
    'default dev wg0 scope link',
    '172.17.0.0/16 dev eth0 proto kernel scope link src 172.17.0.2',
    'default via 10.66.0.1 dev imp0',
  ].join('\n');

  expect(parseUplinks(routes)).toEqual(['eth0', 'wg0']);
  expect(parseUplinks('')).toEqual([]);
});

test('a multipath default route’s uplinks are on its nexthop lines', () => {
  const routes = [
    'default proto ra metric 1024 expires 1797sec pref medium',
    '\tnexthop via fe80::1 dev eth0 weight 1',
    '\tnexthop via fe80::2 dev eth1 weight 1',
    '\tnexthop via fe80::3 dev imp4 weight 1',
    '2001:db8:1::/64 proto static metric 1024 pref medium',
    '\tnexthop via fe80::9 dev wg0 weight 1',
  ].join('\n');

  expect(parseUplinks(routes)).toEqual(['eth0', 'eth1']);
});

test('the interface a route leaves by, and an error for a route with none', () => {
  expect(
    parseRouteDevice(
      '93.184.216.34 via 172.17.0.1 dev eth0 src 172.17.0.2 uid 0\n    cache\n',
      'x',
    ),
  ).toBe('eth0');

  expect(parseRouteDevice('local 172.17.0.2 dev lo table local src 172.17.0.2', 'x')).toBe('lo');

  expect(() => parseRouteDevice('unreachable 203.0.113.9 table main', '203.0.113.9')).toThrow(
    'ip route get 203.0.113.9 named no interface: unreachable 203.0.113.9 table main',
  );
});
