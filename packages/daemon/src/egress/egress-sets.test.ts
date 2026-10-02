import { expect, test } from 'bun:test';
import { createEgressSets } from './egress-sets';

const LIMITS = { minTtlS: 300, maxTtlS: 86_400, maxPerSlot: 3 };

test('an answer adds its addresses once, and the clamped TTL decides the expiry', () => {
  const sets = createEgressSets(LIMITS);

  expect(sets.record(1, ['github.com'], [{ address: '140.82.112.3', ttlS: 60 }], 0)).toEqual({
    added: ['140.82.112.3'],
    removed: [],
  });

  // a second answer for the address extends it, and adds nothing to nft
  expect(sets.record(1, ['github.com'], [{ address: '140.82.112.3', ttlS: 600 }], 1000)).toEqual({
    added: [],
    removed: [],
  });

  // 60 s became 300 s; the second answer moved it to 1 s + 600 s
  expect(sets.sweep(300_000).size).toBe(0);
  expect(sets.sweep(601_000)).toEqual(new Map([[1, ['140.82.112.3']]]));
  expect(sets.listAddresses(1)).toEqual([]);

  sets.record(1, ['big.test'], [{ address: '192.0.2.1', ttlS: 1_000_000 }], 0);

  expect(sets.sweep(86_400_000)).toEqual(new Map([[1, ['192.0.2.1']]]));
});

test('the CNAME chain from an allowed name makes aliases for their TTL', () => {
  const sets = createEgressSets(LIMITS);

  sets.record(
    2,
    ['registry.npmjs.org', 'registry.npmjs.org.cdn.cloudflare.net'],
    [{ address: '104.16.0.1', ttlS: 300 }],
    0,
  );

  expect(sets.isAlias(2, 'registry.npmjs.org.cdn.cloudflare.net', 1000)).toBeTrue();
  expect(sets.isAlias(2, 'registry.npmjs.org', 1000)).toBeFalse();
  expect(sets.isAlias(3, 'registry.npmjs.org.cdn.cloudflare.net', 1000)).toBeFalse();

  sets.sweep(300_000);

  expect(sets.isAlias(2, 'registry.npmjs.org.cdn.cloudflare.net', 300_000)).toBeFalse();
});

test('a full set drops what expires soonest, never the answer being added', () => {
  const sets = createEgressSets(LIMITS);

  sets.record(1, ['a.test'], [{ address: '192.0.2.1', ttlS: 400 }], 0);
  sets.record(1, ['b.test'], [{ address: '192.0.2.2', ttlS: 300 }], 0);
  sets.record(1, ['c.test'], [{ address: '192.0.2.3', ttlS: 500 }], 0);

  const change = sets.record(
    1,
    ['d.test'],
    [
      { address: '192.0.2.4', ttlS: 300 },
      { address: '192.0.2.5', ttlS: 300 },
    ],
    0,
  );

  expect(change).toEqual({
    added: ['192.0.2.4', '192.0.2.5'],
    removed: ['192.0.2.2', '192.0.2.1'],
  });

  expect(sets.listAddresses(1).toSorted()).toEqual(['192.0.2.3', '192.0.2.4', '192.0.2.5']);
});

test('a prune keeps the addresses a remaining name covers, and drops every alias', () => {
  const sets = createEgressSets(LIMITS);

  sets.record(1, ['github.com'], [{ address: '192.0.2.1', ttlS: 300 }], 0);
  sets.record(1, ['npmjs.org', 'npm.cdn.test'], [{ address: '192.0.2.2', ttlS: 300 }], 0);
  sets.record(1, ['other.test'], [{ address: '192.0.2.1', ttlS: 300 }], 0);

  expect(sets.prune(1, (name) => name === 'other.test')).toEqual(['192.0.2.2']);
  expect(sets.listAddresses(1)).toEqual(['192.0.2.1']);
  expect(sets.isAlias(1, 'npm.cdn.test', 0)).toBeFalse();

  sets.clear(1);

  expect(sets.listAddresses(1)).toEqual([]);
});
