// How often views that show live state ask impd again. impd's event stream
// (use-impd-events.ts) refreshes them on each change; the clock is for what
// moves with no event: RAM in use, sessions, last activity.
export const LIVE = { refetchInterval: 10_000 } as const;

// for lists that change only by what someone does: images, checkpoints
export const SLOW = { refetchInterval: 10_000 } as const;
