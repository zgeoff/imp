import { LRUCache } from 'lru-cache';

interface TtlCacheOptions {
  // the most entries kept; a set past it drops the least recently used
  readonly max: number;

  // how long an entry counts from its set: it is gone once its age passes
  // `ttlMs`, and still there at exactly `ttlMs`
  readonly ttlMs: number;

  // the clock the ages read: a test passes buildStubClock's
  readonly now: () => number;
}

// An lru-cache whose entries expire `ttlMs` after their set, on the clock
// the caller injects. Ages are read at each call, never cached between calls,
// and no timer purges in the background, so a stub clock alone moves them.
export function createTtlCache<K extends NonNullable<unknown>, V extends NonNullable<unknown>>(
  options: Readonly<TtlCacheOptions>,
): LRUCache<K, V> {
  return new LRUCache<K, V>({
    max: options.max,
    ttl: options.ttlMs,

    // lru-cache reads a start time of 0 as no start, so an entry set at a
    // stub clock's 0 would never expire: only differences count, so one
    // more ms keeps every start above 0
    perf: { now: () => options.now() + 1 },

    // lru-cache otherwise reuses one reading of the clock for 1 ms of real
    // time, which a stub clock does not pass
    ttlResolution: 0,
  });
}
