import { expect, test } from 'bun:test';
import { buildStubClock } from '../test-utils/build-stub-clock';
import { createTtlCache } from './ttl-cache';

test('it keeps an entry set at the clock time 0 until its time passes', () => {
  const clock = buildStubClock();
  const cache = createTtlCache<string, string>({ max: 10, ttlMs: 1000, now: clock.now });

  cache.set('a', 'kept');
  clock.runFor(1000);

  expect(cache.get('a')).toBe('kept');
});

test('it drops an entry once its age passes the time', () => {
  const clock = buildStubClock();
  const cache = createTtlCache<string, string>({ max: 10, ttlMs: 1000, now: clock.now });

  cache.set('a', 'gone');
  clock.runFor(1001);

  expect(cache.get('a')).toBeUndefined();
});

test('it ages an entry from its last set', () => {
  const clock = buildStubClock({ startMs: 1_700_000_000_000 });
  const cache = createTtlCache<string, string>({ max: 10, ttlMs: 1000, now: clock.now });

  cache.set('a', 'first');
  clock.runFor(800);
  cache.set('a', 'second');
  clock.runFor(800);

  expect(cache.get('a')).toBe('second');
});

test('it drops the least recently used entry past its size', () => {
  const clock = buildStubClock();
  const cache = createTtlCache<string, number>({ max: 2, ttlMs: 1000, now: clock.now });

  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3);

  expect([...cache.keys()]).toIncludeSameMembers(['a', 'c']);
});
