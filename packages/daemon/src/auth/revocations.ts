// Ends what a token opened when it is removed: its dashboard event streams,
// its event streams over the API, and its /exec and /tunnel sockets. A
// session cookie needs nothing here: it names the token, which is gone.
export interface Revocations {
  // aborts when the token is removed; null for a caller with no token
  readonly readSignal: (tokenId: string | null) => AbortSignal | null;
  readonly revoke: (tokenId: string) => void;
}

// A removed token's id stays revoked for good: a request authenticated just
// before the removal asks for its signal after it, and gets an aborted one.
export function createRevocations(): Revocations {
  const controllers = new Map<string, AbortController>();
  const revoked = new Set<string>();

  return {
    readSignal: (tokenId) => {
      if (tokenId === null) {
        return null;
      }

      if (revoked.has(tokenId)) {
        return AbortSignal.abort();
      }

      const existing = controllers.get(tokenId);

      if (existing !== undefined) {
        return existing.signal;
      }

      const controller = new AbortController();

      controllers.set(tokenId, controller);

      return controller.signal;
    },
    revoke: (tokenId) => {
      revoked.add(tokenId);
      controllers.get(tokenId)?.abort();
      controllers.delete(tokenId);
    },
  };
}
