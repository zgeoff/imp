// How often views that show live state ask impd again. impd has no event
// stream yet (#38); when it does, these queries follow it instead of a clock.
export const LIVE = { refetchInterval: 2000 } as const;

// for lists that change only by what someone does: images, checkpoints
export const SLOW = { refetchInterval: 10_000 } as const;
