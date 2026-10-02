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
