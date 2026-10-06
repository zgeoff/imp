import { expect, test } from 'bun:test';
import { REFUSED_RANGES } from '../broker/tunnel-target';
import { createRangeChecker } from './range-checker';
import { BLOCKED_RANGES6, DOCUMENTATION_RANGES6, RESERVED_RANGES6 } from './ranges6';

// The IANA special-purpose registries (iana-ipv4-special-registry and
// iana-ipv6-special-registry, 2025-10-09): every block not globally
// reachable, Teredo, 6to4 and the old ORCHID, and multicast; first and last.
const NOT_GLOBAL4: readonly (readonly [string, string])[] = [
  ['0.0.0.0', '0.255.255.255'],
  ['10.0.0.0', '10.255.255.255'],
  ['100.64.0.0', '100.127.255.255'],
  ['127.0.0.0', '127.255.255.255'],
  ['169.254.0.0', '169.254.255.255'],
  ['172.16.0.0', '172.31.255.255'],
  ['192.0.0.0', '192.0.0.255'],
  ['192.0.2.0', '192.0.2.255'],
  ['192.88.99.0', '192.88.99.255'],
  ['192.168.0.0', '192.168.255.255'],
  ['198.18.0.0', '198.19.255.255'],
  ['198.51.100.0', '198.51.100.255'],
  ['203.0.113.0', '203.0.113.255'],
  ['224.0.0.0', '239.255.255.255'],
  ['240.0.0.0', '255.255.255.254'],
  ['255.255.255.255', '255.255.255.255'],
];

const NOT_GLOBAL6: readonly (readonly [string, string])[] = [
  ['::', '::'],
  ['::1', '::1'],
  ['::ffff:0:0', '::ffff:ffff:ffff'],
  ['64:ff9b::', '64:ff9b::ffff:ffff'],
  ['64:ff9b:1::', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff'],
  ['100::', '100::ffff:ffff:ffff:ffff'],
  ['100:0:0:1::', '100::1:ffff:ffff:ffff:ffff'],
  ['2001::', '2001:0:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2001:2::', '2001:2:0:ffff:ffff:ffff:ffff:ffff'],
  ['2001:10::', '2001:1f:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2001:db8::', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['2002::', '2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['3fff::', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['5f00::', '5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['fc00::', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['fe80::', 'febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['ff00::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
];

const isRefused = createRangeChecker(
  REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
  [...BLOCKED_RANGES6, ...DOCUMENTATION_RANGES6],
);

test('every block the registries mark not globally reachable is refused', () => {
  const missed = [...NOT_GLOBAL4, ...NOT_GLOBAL6].flat().filter((address) => !isRefused(address));

  expect(missed).toEqual([]);
});

test("2001::/23's globally reachable anycast services stay reachable", () => {
  for (const address of ['2001:1::1', '2001:1::3', '2001:3::1', '2001:4:112::1', '2001:20::1']) {
    expect({ address, refused: isRefused(address) }).toEqual({ address, refused: false });
  }

  expect(isRefused('2606:4700:4700::1111')).toBeFalse();
  expect(isRefused('93.184.215.14')).toBeFalse();
});

test('a public imp is refused the rest of 2001::/23, and keeps its global blocks', () => {
  const isPublicRefused = createRangeChecker(
    [],
    [...BLOCKED_RANGES6, ...DOCUMENTATION_RANGES6, ...RESERVED_RANGES6],
  );

  const refused = [
    '2001::',
    '2001:1::1',
    '2001:1:ffff::1',
    '2001:2:1::1',
    '2001:4::1',
    '2001:4:111::1',
  ];

  const reserved = [
    '2001:4:113::',
    '2001:5::1',
    '2001:6::1',
    '2001:8::1',
    '2001:40::1',
    '2001:1ff::1',
  ];

  for (const address of [...refused, ...reserved, '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff']) {
    expect({ address, refused: isPublicRefused(address) }).toEqual({ address, refused: true });
  }

  const global = [
    '2001:3::1',
    '2001:4:112::1',
    '2001:20::1',
    '2001:2f:ffff::1',
    '2001:30::1',
    '2001:3f::1',
  ];

  for (const address of [...global, '2001:200::1', '2606:4700:4700::1111']) {
    expect({ address, refused: isPublicRefused(address) }).toEqual({ address, refused: false });
  }
});
