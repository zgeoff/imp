import type { McpServer } from '../mcp-server';

export interface McpSession {
  readonly id: string;
  readonly key: string;
  readonly server: McpServer;
}

interface SessionState extends McpSession {
  lastUsedAt: number;

  // calls in flight: a busy session is never swept or evicted
  busy: number;
  readonly forgetEnds: () => void;
}

interface SessionStoreOptions {
  readonly limits: {
    readonly perCaller: number;
    readonly total: number;
    readonly idleMs: number;
  };
  readonly now: () => number;
  readonly createServer: () => McpServer;
}

interface SessionOwner {
  readonly key: string;
  readonly ends: AbortSignal | null;
}

// The MCP sessions of one impd, in memory: a restart ends them all, and a
// client then gets 404 and initializes again. Each belongs to the caller that
// opened it, and ends with what that caller authenticated with.
export function createSessionStore(options: Readonly<SessionStoreOptions>) {
  const sessions = new Map<string, SessionState>();

  const stopSession = async (session: Readonly<McpSession>): Promise<void> => {
    const state = sessions.get(session.id);

    if (state === undefined) {
      return;
    }

    sessions.delete(session.id);
    state.forgetEnds();

    await state.server.close();
  };

  // room for one more session of `key`, by evicting idle ones; false when
  // every session in the way is busy
  const makeRoom = (key: string): boolean => {
    const all = [...sessions.values()];
    const own = all.filter((state) => state.key === key);

    for (const [count, limit, pool] of [
      [own.length, options.limits.perCaller, own],
      [all.length, options.limits.total, all],
    ] as const) {
      if (count >= limit) {
        const evicted = findEvictable(pool);

        if (evicted === null) {
          return false;
        }

        void stopSession(evicted);
      }
    }

    return true;
  };

  return {
    // null when the limits leave no room
    open: (owner: Readonly<SessionOwner>): McpSession | null => {
      if (owner.ends?.aborted === true || !makeRoom(owner.key)) {
        return null;
      }

      const id = crypto.randomUUID();

      const onEnd = (): void => {
        const state = sessions.get(id);

        if (state !== undefined) {
          void stopSession(state);
        }
      };

      owner.ends?.addEventListener('abort', onEnd, { once: true });

      const state: SessionState = {
        id,
        key: owner.key,
        server: options.createServer(),
        lastUsedAt: options.now(),
        busy: 0,
        forgetEnds: () => owner.ends?.removeEventListener('abort', onEnd),
      };

      sessions.set(id, state);

      return state;
    },

    // another caller's session is not found
    get: (id: string, key: string): McpSession | null => {
      const state = sessions.get(id);

      if (state?.key !== key) {
        return null;
      }

      state.lastUsedAt = options.now();

      return state;
    },

    // runs one message's handling, which keeps the session from a sweep
    track: async (session: Readonly<McpSession>, handle: () => Promise<void>): Promise<void> => {
      const state = sessions.get(session.id);

      if (state !== undefined) {
        state.busy += 1;
      }

      try {
        await handle();
      } finally {
        if (state !== undefined) {
          state.busy -= 1;
          state.lastUsedAt = options.now();
        }
      }
    },
    end: stopSession,

    // ends sessions idle for longer than the limit
    sweep: (): void => {
      const cutoff = options.now() - options.limits.idleMs;

      for (const state of sessions.values()) {
        if (state.busy === 0 && state.lastUsedAt < cutoff) {
          void stopSession(state);
        }
      }
    },
    endAll: async (): Promise<void> => {
      await Promise.all([...sessions.values()].map((state) => stopSession(state)));
    },
  };
}

// the least recently used idle session of these, to make room
function findEvictable(candidates: readonly Readonly<SessionState>[]): McpSession | null {
  const idle = candidates.filter((state) => state.busy === 0);

  return idle.toSorted((a, b) => a.lastUsedAt - b.lastUsedAt)[0] ?? null;
}
