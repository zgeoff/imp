// Ends what a token opened when it is removed: its dashboard event streams,
// its event streams over the API, and its /exec and /tunnel sockets. A
// session cookie needs nothing here: it names the token, which is gone.
export interface Revocations {
  // aborts when the token is removed; null for a caller with no token
  readonly readSignal: (tokenId: string | null) => AbortSignal | null;
  readonly revoke: (tokenId: string) => void;
}

export function createRevocations(): Revocations {
  const controllers = new Map<string, AbortController>();

  return {
    readSignal: (tokenId) => {
      if (tokenId === null) {
        return null;
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
      controllers.get(tokenId)?.abort();
      controllers.delete(tokenId);
    },
  };
}
