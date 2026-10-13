import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { Server } from '@modelcontextprotocol/server';
import { createCallRegistry } from '../create-call-registry';
import type { CallRegistry } from '../create-call-registry';
import type { McpCaller } from '../create-caller-auth';

export interface LegacySession {
  readonly id: string;

  // the caller that opened it, the only one it answers
  readonly key: string;
  readonly transport: WebStandardStreamableHTTPServerTransport;
}

interface SessionState extends LegacySession {
  readonly server: Server;
  readonly drain: () => Promise<void>;
  lastUsedAt: number;

  // tool calls in flight: a busy session is never swept or evicted
  busy: number;
  readonly forgetEnds: () => void;
}

export interface SessionOwner extends McpCaller {
  readonly key: string;

  // aborts when what the caller authenticated with ends; its sessions end
  readonly ends: AbortSignal | null;
}

interface LegacySessionsOptions {
  readonly limits: {
    readonly perCaller: number;
    readonly total: number;
    readonly idleMs: number;
  };
  readonly now: () => number;

  // between SSE comments, so no idle timeout ends a long call's stream
  readonly keepaliveMs: number;
  readonly createServer: (owner: Readonly<SessionOwner>, calls: Readonly<CallRegistry>) => Server;
}

// The 2025-era MCP sessions of one impd, in memory: a restart ends them all.
// The SDK's transport has no hook for a session limit, an idle sweep or the
// caller a session belongs to, so those live here.
export function createLegacySessions(options: Readonly<LegacySessionsOptions>) {
  const sessions = new Map<string, SessionState>();

  const stopSession = async (session: Readonly<LegacySession>): Promise<void> => {
    const state = sessions.get(session.id);

    if (state === undefined) {
      return;
    }

    sessions.delete(session.id);
    state.forgetEnds();

    // closes the session's streams and aborts its calls, which then stop
    await state.server.close();
    await state.drain();
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
    open: async (owner: Readonly<SessionOwner>): Promise<LegacySession | null> => {
      if (owner.ends?.aborted === true || !makeRoom(owner.key)) {
        return null;
      }

      const id = crypto.randomUUID();
      const calls = createCallRegistry();
      const server = options.createServer(owner, calls);

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => id,
        keepAliveMs: options.keepaliveMs,
      });

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
        transport,
        server,
        drain: calls.drain,
        lastUsedAt: options.now(),
        busy: 0,
        forgetEnds: () => owner.ends?.removeEventListener('abort', onEnd),
      };

      sessions.set(id, state);

      await server.connect(calls.createGate(transport));

      return state;
    },

    // another caller's session is not found
    findOwned: (id: string, key: string): LegacySession | null => {
      const state = sessions.get(id);

      if (state?.key !== key) {
        return null;
      }

      state.lastUsedAt = options.now();

      return state;
    },

    // counts a tool call until it ends, which keeps the session from a sweep
    track: (session: Readonly<LegacySession>, ended: Promise<void>): void => {
      const state = sessions.get(session.id);

      if (state === undefined) {
        return;
      }

      state.busy += 1;

      void (async () => {
        await ended;

        state.busy -= 1;
        state.lastUsedAt = options.now();
      })();
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
function findEvictable(candidates: readonly Readonly<SessionState>[]): LegacySession | null {
  const idle = candidates.filter((state) => state.busy === 0);

  return idle.toSorted((a, b) => a.lastUsedAt - b.lastUsedAt)[0] ?? null;
}
