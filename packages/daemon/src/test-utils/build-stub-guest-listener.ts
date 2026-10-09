import type { GuestListener, ListenSpec } from '../agent-client/listener-stream';

// each waiting client's connection id, or null where the listener ends
interface StubListenerQueue {
  readonly ids: (number | null)[];
  wake: (() => void) | null;
}

// A guest socket as the agent's listen opens it: the path or port asked for
// (its own path for none, 41000 for port 0). The test connects clients and
// ends it as a forced sleep does; a close ends it too.
export function buildStubGuestListener(id: string, spec: ListenSpec) {
  const queue: StubListenerQueue = { ids: [], wake: null };
  const state = { isClosed: false };

  const sendId = (next: number | null): void => {
    queue.ids.push(next);
    queue.wake?.();
  };

  // the next client, or null once the listener ended
  const readNext = async (): Promise<number | null> => {
    while (queue.ids.length === 0) {
      await new Promise<void>((resolve) => {
        queue.wake = resolve;
      });
    }

    return queue.ids.shift() ?? null;
  };

  const listener: GuestListener = {
    path: spec.network === 'tcp' ? null : readUnixPath(id, spec),
    port: spec.network === 'tcp' ? spec.port || 41_000 : null,
    id,
    connections: () => readConnections(readNext),
    close: () => {
      state.isClosed = true;

      sendId(null);
    },
  };

  return {
    listener,
    state,

    // a guest client connects, waiting for an accept under `connection`
    connect: (connection: number): void => {
      sendId(connection);
    },

    // the agent connection ended, as after a forced sleep
    end: (): void => {
      sendId(null);
    },
  };
}

function readUnixPath(id: string, spec: ListenSpec): string {
  return spec.network === 'unix' && spec.path !== null ? spec.path : `/run/imp/forward/${id}/sock`;
}

async function* readConnections(
  readNext: () => Promise<number | null>,
): AsyncGenerator<number, void, undefined> {
  for (;;) {
    const next = await readNext();

    if (next === null) {
      return;
    }

    yield next;
  }
}
