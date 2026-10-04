// Limits per public imp (docs/guides/https.md#how-it-works-1). They count by imp,
// not by client: behind Docker's userland proxy every client can share one
// source address, so a limit by address would lock everyone out at once.

// requests and WebSockets one public imp holds open at once
const MAX_OPEN = 64;

// a burst, then one more every so many milliseconds
const WAKE_BUCKET = { size: 10, refillMs: 6000 };
const FAILURE_BUCKET = { size: 20, refillMs: 3000 };

export interface PublicLimits {
  // a release for one more open request, or null at the cap
  readonly tryOpen: (impId: string) => (() => void) | null;

  // false when the imp woke too often lately
  readonly tryWake: (impId: string) => boolean;

  // counts a wrong or missing credential; false when there were too many
  readonly tryFail: (impId: string) => boolean;

  // seconds until the wake or failure bucket holds one again
  readonly readRetryS: (kind: 'wake' | 'failure') => number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export function createPublicLimits(now: () => number = Date.now): PublicLimits {
  const open = new Map<string, number>();

  const tryWake = createBuckets(WAKE_BUCKET, now);
  const tryFail = createBuckets(FAILURE_BUCKET, now);

  return {
    tryOpen: (impId) => {
      const count = open.get(impId) ?? 0;

      if (count >= MAX_OPEN) {
        return null;
      }

      open.set(impId, count + 1);

      let isReleased = false;

      return () => {
        if (isReleased) {
          return;
        }

        isReleased = true;

        const left = (open.get(impId) ?? 1) - 1;

        if (left === 0) {
          open.delete(impId);
        } else {
          open.set(impId, left);
        }
      };
    },
    tryWake,
    tryFail,
    readRetryS: (kind) =>
      Math.ceil((kind === 'wake' ? WAKE_BUCKET : FAILURE_BUCKET).refillMs / 1000),
  };
}

// A token bucket per key: false when the key has none left. Keys must be
// few, such as public imps or known clients: the map keeps one per key.
export function createBuckets(
  spec: Readonly<{ size: number; refillMs: number }>,
  now: () => number,
): (key: string) => boolean {
  const buckets = new Map<string, Bucket>();

  return (key) => {
    const at = now();
    const bucket = buckets.get(key) ?? { tokens: spec.size, at };
    const refilled = Math.min(spec.size, bucket.tokens + (at - bucket.at) / spec.refillMs);
    const isTaken = refilled >= 1;

    buckets.set(key, { tokens: isTaken ? refilled - 1 : refilled, at });

    return isTaken;
  };
}
