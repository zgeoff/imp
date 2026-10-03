import { expect, test } from 'bun:test';
import { parseConnectedPrefixes4, parseUplinks } from './host-routes';

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
