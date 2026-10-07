import { expect, test } from 'bun:test';
import { BrokerRuleSchema } from './secret-schema';

function parseUpstream(upstream: string) {
  return BrokerRuleSchema.safeParse({
    host: 'svc.imp.internal',
    header: 'authorization',
    scheme: 'bearer',
    upstream,
  });
}

test('an upstream is an http or https origin, kept without a trailing slash', () => {
  const accepted: readonly (readonly [string, string])[] = [
    ['http://172.17.0.1:18081', 'http://172.17.0.1:18081'],
    ['https://x.example.com', 'https://x.example.com'],
    ['https://x.example.com/', 'https://x.example.com'],
  ];

  for (const [given, kept] of accepted) {
    const parsed = parseUpstream(given);

    expect({ given, upstream: parsed.data?.upstream }).toEqual({ given, upstream: kept });
  }
});

test('an upstream with another scheme, credentials, a path, a query or a fragment is refused', () => {
  const refused = [
    'ftp://x.example.com',
    'x.example.com',
    'https://user:pass@x.example.com',
    'https://user@x.example.com',
    'https://x.example.com/api',
    'https://x.example.com?a=1',
    'https://x.example.com/?',
    'https://x.example.com#top',
    `https://${'a'.repeat(2048)}.example.com`,
  ];

  for (const given of refused) {
    expect({ given, ok: parseUpstream(given).success }).toEqual({ given, ok: false });
  }
});

test('a rule needs no upstream', () => {
  const parsed = BrokerRuleSchema.safeParse({
    host: 'api.example.com',
    header: 'authorization',
    scheme: 'bearer',
  });

  expect(parsed.success).toBe(true);
});
