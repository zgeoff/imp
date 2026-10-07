import { expect, test } from 'bun:test';
import { EgressAllowEntrySchema, EgressModeSchema, EgressPolicySchema } from './egress-schema';

test.each([
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
])('#EgressAllowEntrySchema accepts %s as an allow entry', (entry) => {
  expect(EgressAllowEntrySchema.safeParse(entry).data).toBe(entry);
});

test.each([
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
])('#EgressAllowEntrySchema rejects %s as an allow entry', (entry) => {
  const result = EgressAllowEntrySchema.safeParse(entry);

  expect(result.error?.issues).toPartiallyContain({
    path: [],
    message:
      'must be a lowercase hostname, *. and a hostname, an IPv4 address or CIDR from /8, or a canonical IPv6 address or CIDR from /16',
  });
});

test('#EgressPolicySchema defaults an open policy to an empty allow-list', () => {
  expect(EgressPolicySchema.safeParse({ mode: 'open' }).data).toStrictEqual({
    mode: 'open',
    allow: [],
  });
});

test('#EgressPolicySchema defaults a public policy to an empty allow-list', () => {
  expect(EgressPolicySchema.safeParse({ mode: 'public' }).data).toStrictEqual({
    mode: 'public',
    allow: [],
  });
});

test('#EgressPolicySchema accepts a box policy with an allow-list', () => {
  const result = EgressPolicySchema.safeParse({ mode: 'box', allow: ['github.com'] });

  expect(result.data).toStrictEqual({ mode: 'box', allow: ['github.com'] });
});

test('#EgressPolicySchema rejects an allow-list on a none policy', () => {
  const result = EgressPolicySchema.safeParse({ mode: 'none', allow: ['github.com'] });

  expect(result.error?.issues).toPartiallyContain({
    path: ['allow'],
    message: 'only a box policy takes an allow-list',
  });
});

test('#EgressPolicySchema rejects an allow-list on a public policy', () => {
  const result = EgressPolicySchema.safeParse({ mode: 'public', allow: ['10.0.0.0/8'] });

  expect(result.error?.issues).toPartiallyContain({
    path: ['allow'],
    message: 'only a box policy takes an allow-list',
  });
});

test('#EgressPolicySchema rejects an unknown mode', () => {
  const result = EgressPolicySchema.safeParse({ mode: 'closed', allow: [] });

  expect(result.error?.issues).toPartiallyContain({ path: ['mode'], code: 'invalid_value' });
});

test('#EgressPolicySchema rejects an invalid entry in a box allow-list', () => {
  const result = EgressPolicySchema.safeParse({ mode: 'box', allow: ['GitHub.com'] });

  expect(result.error?.issues).toPartiallyContain({ path: ['allow', 0], code: 'custom' });
});

test.each(['open', 'public', 'box', 'none'])('#EgressModeSchema accepts the mode %s', (mode) => {
  expect(EgressModeSchema.safeParse(mode).data).toBe(mode);
});

test('#EgressModeSchema rejects an unknown mode', () => {
  const result = EgressModeSchema.safeParse('closed');

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'invalid_value' });
});
