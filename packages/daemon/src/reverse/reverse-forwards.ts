import { MAX_RELAYS_PER_FORWARD } from './run-guest-listener';

// The reverse forwards `/tunnel` control sockets hold, shared by every tunnel
// socket: an accept must come from the caller that listened, for the same
// imp, and a forward has at most MAX_RELAYS_PER_FORWARD relays open.
export interface ReverseForwards {
  // a release to call once the control socket ends
  readonly register: (listener: string, impId: string, owner: string) => () => void;

  // a release to call once the relay ends, or why it is refused
  readonly tryAccept: (
    listener: string,
    impId: string,
    owner: string,
  ) => { readonly release: () => void } | { readonly refused: 'unknown' | 'full' };
  readonly isFull: (listener: string) => boolean;
}

interface ForwardEntry {
  readonly impId: string;
  readonly owner: string;
}

export function createReverseForwards(max = MAX_RELAYS_PER_FORWARD): ReverseForwards {
  const entries = new Map<string, ForwardEntry>();
  const relays = new Map<string, number>();

  const countRelays = (listener: string): number => relays.get(listener) ?? 0;

  return {
    register: (listener, impId, owner) => {
      entries.set(listener, { impId, owner });

      return () => {
        entries.delete(listener);
      };
    },
    tryAccept: (listener, impId, owner) => {
      const entry = entries.get(listener);

      if (entry?.impId !== impId || entry.owner !== owner) {
        return { refused: 'unknown' };
      }

      if (countRelays(listener) >= max) {
        return { refused: 'full' };
      }

      relays.set(listener, countRelays(listener) + 1);

      let released = false;

      return {
        release: () => {
          if (released) {
            return;
          }

          released = true;

          const left = countRelays(listener) - 1;

          if (left <= 0) {
            relays.delete(listener);
          } else {
            relays.set(listener, left);
          }
        },
      };
    },
    isFull: (listener) => countRelays(listener) >= max,
  };
}
