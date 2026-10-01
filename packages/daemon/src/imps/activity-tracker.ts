// Host-side connections that keep an imp awake: exec sessions and proxied
// HTTP requests or WebSockets (DESIGN 2.9).

type ConnectionKind = 'exec' | 'proxy';

function buildKey(impId: string, kind: ConnectionKind): string {
  return `${impId}:${kind}`;
}

export interface ActivityTracker {
  // counts one connection until the returned function runs (once is enough;
  // later calls do nothing)
  readonly open: (impId: string, kind: ConnectionKind) => () => void;
  readonly count: (impId: string, kind?: ConnectionKind) => number;
}

export function createActivityTracker(): ActivityTracker {
  const counts = new Map<string, number>();

  const readCount = (impId: string, kind: ConnectionKind): number =>
    counts.get(buildKey(impId, kind)) ?? 0;

  return {
    open: (impId, kind) => {
      const key = buildKey(impId, kind);
      let open = true;

      counts.set(key, (counts.get(key) ?? 0) + 1);

      return () => {
        if (!open) {
          return;
        }

        open = false;

        const left = (counts.get(key) ?? 1) - 1;

        if (left === 0) {
          counts.delete(key);
        } else {
          counts.set(key, left);
        }
      };
    },
    count: (impId, kind) =>
      kind === undefined
        ? readCount(impId, 'exec') + readCount(impId, 'proxy')
        : readCount(impId, kind),
  };
}
