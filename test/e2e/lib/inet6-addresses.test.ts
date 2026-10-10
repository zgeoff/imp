import { expect, test } from 'bun:test';
import { parseInet6Addresses } from './inet6-addresses';

test('it lists the global and link addresses and leaves out loopback', () => {
  const shown = [
    String.raw`1: lo    inet6 ::1/128 scope host noprefixroute \       valid_lft forever preferred_lft forever`,
    String.raw`2: eth0    inet6 fd00:dead:beef::2/64 scope global nodad \       valid_lft forever preferred_lft forever`,
    String.raw`2: eth0    inet6 fe80::42:acff:fe11:2/64 scope link \       valid_lft forever preferred_lft forever`,
    '',
  ].join('\n');

  expect(parseInet6Addresses(shown)).toStrictEqual(['fd00:dead:beef::2', 'fe80::42:acff:fe11:2']);
});

test('it lists nothing for a host without IPv6 addresses', () => {
  expect(parseInet6Addresses('')).toStrictEqual([]);
});
