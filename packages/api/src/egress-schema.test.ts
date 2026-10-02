import { expect, test } from 'bun:test';
import { EgressAllowEntrySchema, EgressPolicySchema } from './egress-schema';

test('an allow entry is a hostname, a wildcard, or an IPv4 address or CIDR', () => {
  for (const entry of [
    'github.com',
    '*.npmjs.org',
    'registry.npmjs.org',
    '_acme.example.com',
    '9.9.9.9',
    '172.17.0.1/32',
    '10.0.0.0/8',
    '2001:db8:b::1',
    '2001:db8:c::/48',
    'fd00:1::/64',
  ]) {
    expect({ entry, ok: EgressAllowEntrySchema.safeParse(entry).success }).toEqual({
      entry,
      ok: true,
    });
  }
});

test('it refuses uppercase, ports, bare wildcards, broad or misaligned CIDRs', () => {
  for (const entry of [
    'GitHub.com',
    'github.com:443',
    '*',
    '*.',
    'a.*.example.com',
    'localhost',
    '0.0.0.0/0',
    '10.0.0.0/7',
    '10.0.0.1/24',
    '256.1.1.1',
    '1.2.3',
    'https://github.com',
    '2001:DB8::1',
    '2001:db8:0::1',
    '2001:db8::1/64',
    '::/0',
    '2001::/15',
    '::ffff:1.2.3.4',
    'fe80::1%eth0',
  ]) {
    expect({ entry, ok: EgressAllowEntrySchema.safeParse(entry).success }).toEqual({
      entry,
      ok: false,
    });
  }
});

test('only a box policy takes an allow-list', () => {
  expect(EgressPolicySchema.parse({ mode: 'open' })).toEqual({ mode: 'open', allow: [] });
  expect(EgressPolicySchema.safeParse({ mode: 'box', allow: ['github.com'] }).success).toBeTrue();
  expect(EgressPolicySchema.safeParse({ mode: 'none', allow: ['github.com'] }).success).toBeFalse();
});
