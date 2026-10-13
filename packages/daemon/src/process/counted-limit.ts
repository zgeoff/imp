// A count per key with a ceiling: a claim past `max` is refused, and each
// granted claim hands back its release.
export interface CountedLimit {
  readonly max: number;

  // a release to call once the claim ends, or null when `key` holds `max`;
  // a second call of the same release does nothing
  readonly tryClaim: (key: string) => (() => void) | null;

  // the claims `key` holds now
  readonly countHeld: (key: string) => number;
  readonly isFull: (key: string) => boolean;
}

export function createCountedLimit(max: number): CountedLimit {
  const held = new Map<string, number>();

  const countHeld = (key: string): number => held.get(key) ?? 0;

  return {
    max,
    tryClaim: (key) => {
      const count = countHeld(key);

      if (count >= max) {
        return null;
      }

      held.set(key, count + 1);

      let isReleased = false;

      return () => {
        if (isReleased) {
          return;
        }

        isReleased = true;

        const left = countHeld(key) - 1;

        if (left <= 0) {
          held.delete(key);
        } else {
          held.set(key, left);
        }
      };
    },
    countHeld,
    isFull: (key) => countHeld(key) >= max,
  };
}
