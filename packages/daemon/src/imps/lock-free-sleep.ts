import type { TryResult } from './keyed-mutex';

// 'skipped' when the imp's lock is taken or it no longer qualifies;
// 'diskFull' when the disk cannot take its memory snapshot
export type SleepOutcome = 'slept' | 'skipped' | 'failed' | 'diskFull';

// What a background sleep checks again under the lock. The governor sleeps
// the least recently active imp, idle or not; the idle loop also needs the
// imp no more active than when it looked.
export type SleepPolicy =
  | { readonly by: 'governor' }
  | { readonly by: 'idle'; readonly seenActiveAt: number };

const LOCK_FREE = Symbol('lock-free');

// A background sleep that never waits for the imp's lock: the governor calls
// it while it holds admission, which a boot under that lock may wait for.
// Only createLockFreeSleep makes one, and only around a try-lock.
export type LockFreeSleep = ((
  id: string,
  reason: string,
  policy: SleepPolicy,
) => Promise<SleepOutcome>) & { readonly [LOCK_FREE]: true };

export function createLockFreeSleep<T>(
  tryLock: (
    id: string,
    action: (held: T) => Promise<SleepOutcome>,
  ) => Promise<TryResult<SleepOutcome>>,
  sleep: (held: T, reason: string, policy: SleepPolicy) => Promise<SleepOutcome>,
): LockFreeSleep {
  const run = async (id: string, reason: string, policy: SleepPolicy): Promise<SleepOutcome> => {
    const result = await tryLock(id, (held) => sleep(held, reason, policy));

    return result.ran ? result.value : 'skipped';
  };

  return Object.assign(run, { [LOCK_FREE]: true as const });
}
