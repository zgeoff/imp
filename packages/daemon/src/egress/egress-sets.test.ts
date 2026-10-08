import { expect, test } from 'bun:test';
import { createEgressSets } from './egress-sets';

test('#record adds a new address to the set', () => {
  const sets = createEgressSets({ minTtlS: 300, maxTtlS: 86_400, maxPerSlot: 3 });
  const change = sets.record(1, ['github.com'], [{ address: '140.82.112.3', ttlS: 60 }], 0);

  expect(change).toStrictEqual({ added: ['140.82.112.3'], removed: [] });
});

test('#record adds nothing for an address the set holds', () => {
  const sets = createEgressSets({ minTtlS: 300, maxTtlS: 86_400, maxPerSlot: 3 });

  sets.record(1, ['github.com'], [{ address: '140.82.112.3', ttlS: 60 }], 0);

  const change = sets.record(1, ['github.com'], [{ address: '140.82.112.3', ttlS: 600 }], 1000);

  expect(change).toStrictEqual({ added: [], removed: [] });
});

test('#record extends the expiry of an address the set holds', () => {
  const sets = createEgressSets({ minTtlS: 300, maxTtlS: 86_400, maxPerSlot: 3 });

  sets.record(1, ['github.com'], [{ address: '140.82.112.3', ttlS: 60 }], 0);
  sets.record(1, ['github.com'], [{ address: '140.82.112.3', ttlS: 600 }], 1000);

  // 1 s plus 600 s
  expect(sets.listAnswers(1, 1000)).toStrictEqual([
    { names: ['github.com'], address: '140.82.112.3', ttlS: 600 },
  ]);
});

test('#sweep keeps an address until its TTL, raised to the minimum, runs out', () => {
  const sets = createEgressSets({ minTtlS: 300, maxTtlS: 86_400, maxPerSlot: 3 });

  sets.record(1, ['github.com'], [{ address: '140.82.112.3', ttlS: 60 }], 0);

  expect(sets.sweep(299_999)).toStrictEqual(new Map());
});

test('#sweep drops an address once its TTL, raised to the minimum, runs out', () => {
  const sets = createEgressSets({ minTtlS: 300, maxTtlS: 86_400, maxPerSlot: 3 });

  sets.record(1, ['github.com'], [{ address: '140.82.112.3', ttlS: 60 }], 0);

  const due = sets.sweep(300_000);

  expect(due).toStrictEqual(new Map([[1, ['140.82.112.3']]]));
  expect(sets.listAddresses(1)).toStrictEqual([]);
});

test('#sweep drops an address at the maximum TTL, whatever longer TTL it came with', () => {
  const sets = createEgressSets({ minTtlS: 300, maxTtlS: 86_400, maxPerSlot: 3 });

  sets.record(1, ['big.test'], [{ address: '192.0.2.1', ttlS: 1_000_000 }], 0);

  expect(sets.sweep(86_400_000)).toStrictEqual(new Map([[1, ['192.0.2.1']]]));
});

test('#isAlias holds each name of the CNAME chain after the first, in its own slot', () => {
  const sets = createEgressSets({ minTtlS: 300, maxTtlS: 86_400, maxPerSlot: 3 });

  sets.record(
    2,
    ['registry.npmjs.org', 'registry.npmjs.org.cdn.cloudflare.net'],
    [{ address: '104.16.0.1', ttlS: 300 }],
    0,
  );

  expect(sets.isAlias(2, 'registry.npmjs.org.cdn.cloudflare.net', 1000)).toBeTrue();
  expect(sets.isAlias(2, 'registry.npmjs.org', 1000)).toBeFalse();
  expect(sets.isAlias(3, 'registry.npmjs.org.cdn.cloudflare.net', 1000)).toBeFalse();
});

test('#sweep drops an alias whose TTL ran out', () => {
  const sets = createEgressSets({ minTtlS: 300, maxTtlS: 86_400, maxPerSlot: 3 });

  sets.record(2, ['a.test', 'cdn.test'], [{ address: '104.16.0.1', ttlS: 300 }], 0);
  sets.sweep(300_000);

  expect(sets.isAlias(2, 'cdn.test', 0)).toBeFalse();
});

test('#record drops what expires soonest from a full set, never the answer being added', () => {
  const sets = createEgressSets({ minTtlS: 300, maxTtlS: 86_400, maxPerSlot: 3 });

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

  expect(change).toStrictEqual({
    added: ['192.0.2.4', '192.0.2.5'],
    removed: ['192.0.2.2', '192.0.2.1'],
  });

  expect(sets.listAddresses(1)).toStrictEqual(['192.0.2.3', '192.0.2.4', '192.0.2.5']);
});

test('#prune keeps the addresses a remaining name covers, and drops every alias', () => {
  const sets = createEgressSets({ minTtlS: 300, maxTtlS: 86_400, maxPerSlot: 3 });

  sets.record(1, ['github.com'], [{ address: '192.0.2.1', ttlS: 300 }], 0);
  sets.record(1, ['npmjs.org', 'npm.cdn.test'], [{ address: '192.0.2.2', ttlS: 300 }], 0);
  sets.record(1, ['other.test'], [{ address: '192.0.2.1', ttlS: 300 }], 0);

  const removed = sets.prune(1, (name) => name === 'other.test');

  expect(removed).toStrictEqual(['192.0.2.2']);
  expect(sets.listAddresses(1)).toStrictEqual(['192.0.2.1']);
  expect(sets.isAlias(1, 'npm.cdn.test', 0)).toBeFalse();
});

test('#prune removes nothing from a slot that holds nothing', () => {
  const sets = createEgressSets({ minTtlS: 300, maxTtlS: 86_400, maxPerSlot: 3 });

  expect(sets.prune(4, () => false)).toStrictEqual([]);
});

test('#clear empties the slot', () => {
  const sets = createEgressSets({ minTtlS: 300, maxTtlS: 86_400, maxPerSlot: 3 });

  sets.record(1, ['github.com', 'gh.cdn.test'], [{ address: '192.0.2.1', ttlS: 300 }], 0);
  sets.clear(1);

  expect(sets.listAddresses(1)).toStrictEqual([]);
  expect(sets.isAlias(1, 'gh.cdn.test', 0)).toBeFalse();
});

test('#listAnswers gives each held address its names and the whole seconds it has left', () => {
  const sets = createEgressSets({ minTtlS: 300, maxTtlS: 86_400, maxPerSlot: 3 });

  sets.record(1, ['npmjs.org', 'npm.cdn.test'], [{ address: '192.0.2.1', ttlS: 400 }], 0);
  sets.record(1, ['github.com'], [{ address: '192.0.2.2', ttlS: 300 }], 0);
  sets.record(1, ['other.test'], [{ address: '192.0.2.1', ttlS: 300 }], 0);

  expect(sets.listAnswers(1, 100_500)).toStrictEqual([
    { names: ['npmjs.org', 'npm.cdn.test', 'other.test'], address: '192.0.2.1', ttlS: 300 },
    { names: ['github.com'], address: '192.0.2.2', ttlS: 200 },
  ]);
});

test('#listAnswers leaves out an address that has expired before the sweep', () => {
  const sets = createEgressSets({ minTtlS: 300, maxTtlS: 86_400, maxPerSlot: 3 });

  sets.record(1, ['github.com'], [{ address: '192.0.2.2', ttlS: 300 }], 0);

  expect(sets.listAnswers(1, 300_000)).toStrictEqual([]);
});
