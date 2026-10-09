import { expect, test } from 'bun:test';
import {
  BLOCKED_RANGES6,
  DOCUMENTATION_RANGES6,
  RESERVED_RANGES6,
  createRangeChecker6,
  readMappedIpv4,
} from './ranges6';

test.each([
  ['fd7a:115c:a1e0::1', 'the tailnet'],
  ['fd00:ec2::254', "a cloud's metadata service"],
  ['fe80::1', 'link-local'],
  ['ff02::1', 'multicast'],
  ['::', 'the unspecified address'],
  ['::1', 'loopback'],
  ['::ffff:8.8.8.8', 'IPv4-mapped'],
  ['::a9fe:a9fe', 'IPv4-compatible'],
  ['::ffff:0:a9fe:a9fe', 'IPv4-translated'],
  ['100::1', 'discard-only'],
  ['64:ff9b::a9fe:a9fe', 'NAT64'],
  ['64:ff9b:1::1', 'local-use NAT64'],
  ['2002:a9fe:a9fe::1', '6to4'],
  ['2001:0:4136:e378::1', 'Teredo'],
  ['8.8.8.8', 'an IPv4 address'],
  ['example.com', 'a name'],
])('it blocks %s, %s', (address) => {
  expect(createRangeChecker6(BLOCKED_RANGES6)(address)).toBeTrue();
});

test.each(['2606:4700:4700::1111', '2001:db8:b::1'])(
  'it passes the public or documentation address %s through the blocklist',
  (address) => {
    expect(createRangeChecker6(BLOCKED_RANGES6)(address)).toBeFalse();
  },
);

// The IANA special-purpose registry (iana-ipv6-special-registry,
// 2025-10-09): the first and last address of every block not globally
// reachable, Teredo, 6to4 and the old ORCHID, and multicast.
test.each([
  ['::', '::/128'],
  ['::1', '::1/128'],
  ['::ffff:0:0', '::ffff:0:0/96'],
  ['::ffff:ffff:ffff', '::ffff:0:0/96'],
  ['64:ff9b::', '64:ff9b::/96'],
  ['64:ff9b::ffff:ffff', '64:ff9b::/96'],
  ['64:ff9b:1::', '64:ff9b:1::/48'],
  ['64:ff9b:1:ffff:ffff:ffff:ffff:ffff', '64:ff9b:1::/48'],
  ['100::', '100::/64'],
  ['100::ffff:ffff:ffff:ffff', '100::/64'],
  ['100:0:0:1::', '100:0:0:1::/64'],
  ['100::1:ffff:ffff:ffff:ffff', '100:0:0:1::/64'],
  ['2001::', '2001::/32'],
  ['2001:0:ffff:ffff:ffff:ffff:ffff:ffff', '2001::/32'],
  ['2001:2::', '2001:2::/48'],
  ['2001:2:0:ffff:ffff:ffff:ffff:ffff', '2001:2::/48'],
  ['2001:10::', '2001:10::/28'],
  ['2001:1f:ffff:ffff:ffff:ffff:ffff:ffff', '2001:10::/28'],
  ['2001:db8::', '2001:db8::/32'],
  ['2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', '2001:db8::/32'],
  ['2002::', '2002::/16'],
  ['2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '2002::/16'],
  ['3fff::', '3fff::/20'],
  ['3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', '3fff::/20'],
  ['5f00::', '5f00::/16'],
  ['5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '5f00::/16'],
  ['fc00::', 'fc00::/7'],
  ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'fc00::/7'],
  ['fe80::', 'fe80::/10'],
  ['febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'fe80::/10'],
  ['ff00::', 'ff00::/8'],
  ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'ff00::/8'],
])('it refuses %s at an end of the registry block %s', (address) => {
  const isRefused = createRangeChecker6([...BLOCKED_RANGES6, ...DOCUMENTATION_RANGES6]);

  expect(isRefused(address)).toBeTrue();
});

test.each([
  '2001:1::1',
  '2001:1::3',
  '2001:3::1',
  '2001:4:112::1',
  '2001:20::1',
  '2606:4700::1111',
])('it keeps %s reachable, a globally reachable service in 2001::/23 or outside it', (address) => {
  const isRefused = createRangeChecker6([...BLOCKED_RANGES6, ...DOCUMENTATION_RANGES6]);

  expect(isRefused(address)).toBeFalse();
});

test.each([
  '2001::',
  '2001:1::1',
  '2001:1:ffff::1',
  '2001:2:1::1',
  '2001:4::1',
  '2001:4:111::1',
  '2001:4:113::',
  '2001:5::1',
  '2001:6::1',
  '2001:8::1',
  '2001:40::1',
  '2001:1ff::1',
  '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff',
])('it refuses a public imp %s, in the rest of 2001::/23', (address) => {
  const isPublicRefused = createRangeChecker6([
    ...BLOCKED_RANGES6,
    ...DOCUMENTATION_RANGES6,
    ...RESERVED_RANGES6,
  ]);

  expect(isPublicRefused(address)).toBeTrue();
});

test.each([
  '2001:3::1',
  '2001:4:112::1',
  '2001:20::1',
  '2001:2f:ffff::1',
  '2001:30::1',
  '2001:3f::1',
  '2001:200::1',
  '2606:4700:4700::1111',
])('it keeps the global block address %s reachable for a public imp', (address) => {
  const isPublicRefused = createRangeChecker6([
    ...BLOCKED_RANGES6,
    ...DOCUMENTATION_RANGES6,
    ...RESERVED_RANGES6,
  ]);

  expect(isPublicRefused(address)).toBeFalse();
});

test.each([
  ['::ffff:169.254.169.254', '169.254.169.254'],
  ['::ffff:a9fe:a9fe', '169.254.169.254'],
])('it reads the IPv4-mapped address %s as %s', (address, ipv4) => {
  expect(readMappedIpv4(address)).toBe(ipv4);
});

test.each(['2001:db8::1', 'example.com'])('it reads %p as holding no IPv4 address', (address) => {
  expect(readMappedIpv4(address)).toBeNull();
});
