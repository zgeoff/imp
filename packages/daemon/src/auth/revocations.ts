// Ends what a token, a bound SSH key or an OAuth grant opened when it is
// removed: event streams, /exec and /tunnel sockets, ssh logins, MCP calls. A session cookie needs
// nothing here: it names the token, which is gone.
export interface Revocations {
  // aborts when the token or key is removed; null for a caller with no id
  readonly readSignal: (id: string | null) => AbortSignal | null;
  readonly revoke: (id: string) => void;

  // whether the id was revoked, for what checks before it opens
  readonly isRevoked: (id: string) => boolean;
}

// A removed id stays revoked for good: a request authenticated just before
// the removal asks for its signal after it, and gets an aborted one. Ids are
// random, so a key bound again gets a new one.
export function createRevocations(): Revocations {
  const controllers = new Map<string, AbortController>();
  const revoked = new Set<string>();

  return {
    readSignal: (id) => {
      if (id === null) {
        return null;
      }

      if (revoked.has(id)) {
        return AbortSignal.abort();
      }

      const existing = controllers.get(id);

      if (existing !== undefined) {
        return existing.signal;
      }

      const controller = new AbortController();

      controllers.set(id, controller);

      return controller.signal;
    },
    revoke: (id) => {
      revoked.add(id);
      controllers.get(id)?.abort();
      controllers.delete(id);
    },
    isRevoked: (id) => revoked.has(id),
  };
}
