import { expect, test } from 'bun:test';
import {
  buildAllowRules,
  isAddressAllowed,
  isNameAllowed,
  isTunnelAllowed,
  listExactNames,
  normalizeName,
} from './egress-rules';

test('#buildAllowRules splits a list into names, suffixes and ranges of each family', () => {
  const rules = buildAllowRules([
    'github.com',
    '*.npmjs.org',
    '172.17.0.1',
    '203.0.113.0/24',
    '2001:db8:b::1',
    '2001:db8:c::/48',
  ]);

  expect(rules).toStrictEqual({
    names: new Set(['github.com']),
    suffixes: ['.npmjs.org'],
    ranges: [
      [2_886_795_265, 1],
      [3_405_803_776, 256],
    ],
    ranges6: [
      [0x20_01_0d_b8_00_0b_00_00_00_00_00_00_00_00_00_01n, 1n],
      [0x20_01_0d_b8_00_0c_00_00_00_00_00_00_00_00_00_00n, 2n ** 80n],
    ],
    cidrs: ['172.17.0.1/32', '203.0.113.0/24', '2001:db8:b::1/128', '2001:db8:c::/48'],
  });
});

test.each([
  ['GitHub.COM', 'github.com'],
  ['github.com.', 'github.com'],
  ['Registry.NPMJS.org.', 'registry.npmjs.org'],
  ['github.com', 'github.com'],
])('#normalizeName reads %p as %p', (name, normal) => {
  expect(normalizeName(name)).toBe(normal);
});

test.each([
  ['github.com', true],
  ['GitHub.COM', true],
  ['github.com.', true],
  ['api.github.com', false],
  ['github.com.evil.test', false],
  ['xgithub.com', false],
  ['registry.npmjs.org', true],
  ['a.b.npmjs.org', true],
  ['REGISTRY.npmjs.org.', true],
  ['npmjs.org', false],
  ['evilnpmjs.org', false],
  ['npmjs.org.evil.test', false],
])('#isNameAllowed under github.com and *.npmjs.org takes %p as %p', (name, allowed) => {
  expect(isNameAllowed(buildAllowRules(['github.com', '*.npmjs.org']), name)).toBe(allowed);
});

test.each([
  ['172.17.0.1', true],
  ['172.17.0.2', false],
  ['203.0.113.0', true],
  ['203.0.113.255', true],
  ['203.0.114.0', false],
  ['github.com', false],
  ['2001:db8:b::1', true],
  ['2001:db8:b::2', false],
  ['2001:db8:c:ffff::1', true],
  ['2001:db8:d::1', false],
])('#isAddressAllowed under a /32, a /24, a /128 and a /48 takes %p as %p', (address, allowed) => {
  const rules = buildAllowRules([
    '172.17.0.1',
    '203.0.113.0/24',
    '2001:db8:b::1',
    '2001:db8:c::/48',
    'github.com',
  ]);

  expect(isAddressAllowed(rules, address)).toBe(allowed);
});

test.each([
  ['open', [], 'example.org', true],
  ['public', [], 'example.org', true],
  ['none', [], 'github.com', false],
  ['box', ['github.com', '172.17.0.1'], 'github.com', true],
  ['box', ['github.com', '172.17.0.1'], '172.17.0.1', true],
  ['box', ['github.com', '172.17.0.1'], 'example.org', false],
] as const)(
  '#isTunnelAllowed under %p with %p takes a tunnel to %p as %p',
  (mode, allow, host, allowed) => {
    expect(isTunnelAllowed({ mode, allow: [...allow] }, host)).toBe(allowed);
  },
);

test('#listExactNames lists only the exact names, which impd can resolve ahead of the guest', () => {
  expect(listExactNames(['github.com', '*.npmjs.org', '9.9.9.9', '2001:db8::/32'])).toStrictEqual([
    'github.com',
  ]);
});
