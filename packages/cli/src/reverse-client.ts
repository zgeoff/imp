import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import type { ImpState } from '@imp/api';
import { ORPCError } from '@orpc/client';
import { openReverseForward } from '@zgeoff/imp-client';
import type {
  ReverseForward,
  ReverseForwardEnd,
  ReverseListening,
  ReverseRelay,
  ReverseRelayHandlers,
} from '@zgeoff/imp-client';
import type { CliConfig } from './cli-config';
import { createImpClient } from './create-imp-client';
import type { ReverseLocal, ReverseSpec } from './parse-reverse';

// what a reverse forward touches besides its sockets; tests swap it
export interface ReverseIo {
  // a line for the user on stderr, after `imp: `
  readonly writeNotice: (text: string) => void;

  // the imp's state now, then each change; throws once the imp is gone.
  // Reading it never wakes the imp.
  readonly watchImp: (
    config: CliConfig,
    name: string,
    signal: AbortSignal,
  ) => AsyncIterable<ImpState>;

  // how long a lost forward waits to see the imp sleep before it listens
  // again on an imp that stayed awake
  readonly lostGraceMs?: number;
  readonly retryMs?: number;
}

export interface ReverseForwarding {
  // where the first listen landed in the imp
  readonly listening: ReverseListening;

  // settles when the forward fails for good; a lost one listens again
  readonly failed: Promise<Error>;
  readonly stop: () => void;
}

// a sleep reports `sleeping` once the snapshot is on disk, after the guest
// listener ended
const LOST_GRACE_MS = 30_000;

// a WebSocket that closed without a handshake: impd is down or unreachable
const CLOSE_ABNORMAL = 1006;

// impd restarting or unreachable: the next try comes after this long
const RETRY_MS = 2000;

const PROCESS_IO: ReverseIo = {
  writeNotice: (text) => {
    console.error(`imp: ${text}`);
  },
  watchImp: (config, name, signal) => readImpStates(config, name, signal),
};

// The imp's state from the event stream, which opens with every imp. The
// stream ends when impd restarts; it opens again after RETRY_MS.
async function* readImpStates(
  config: CliConfig,
  name: string,
  signal: AbortSignal,
): AsyncGenerator<ImpState> {
  const client = createImpClient(config);

  while (!signal.aborted) {
    try {
      const stream = await client.events.stream(undefined, { signal });

      for await (const event of stream) {
        if (event.ev === 'ImpRemoved' && event.imp.name === name) {
          throw new Error(`${name} was destroyed`);
        }

        if ((event.ev === 'ImpAdded' || event.ev === 'ImpChanged') && event.imp.name === name) {
          yield event.imp.state;
        }
      }
    } catch (error) {
      // an impd that refuses the stream refuses it again
      if (signal.aborted || !(error instanceof ORPCError) || error.status < 500) {
        throw error;
      }
    }

    await Bun.sleep(RETRY_MS);
  }
}

export function formatLocal(local: ReverseLocal): string {
  return local.network === 'unix' ? local.path : `localhost:${String(local.port)}`;
}

export function formatGuest(listening: ReverseListening): string {
  return listening.path ?? String(listening.port);
}

function openLocal(local: ReverseLocal): Socket {
  if (local.network === 'unix') {
    return createConnection({ path: local.path, allowHalfOpen: true });
  }

  return createConnection({ host: '127.0.0.1', port: local.port, allowHalfOpen: true });
}

// One client in the imp, relayed to a new connection to the local side. The
// local socket pauses while more than the window waits for impd's acks.
function openLocalRelay(
  accept: (handlers: ReverseRelayHandlers) => ReverseRelay,
  local: ReverseLocal,
  writeNotice: (text: string) => void,
): void {
  const socket = openLocal(local);

  const relay = accept({
    onData: (data) =>
      new Promise<void>((resolve) => {
        socket.write(data, () => {
          resolve();
        });
      }),
    onEof: () => {
      socket.end();
    },
    onClose: () => {
      socket.destroy();
    },
  });

  const waitAndResume = async (): Promise<void> => {
    await relay.waitForRoom();

    socket.resume();
  };

  socket.on('data', (chunk: Buffer) => {
    if (!relay.send(chunk)) {
      socket.pause();
      void waitAndResume();
    }
  });

  socket.on('end', () => {
    relay.sendEof();
  });

  socket.on('error', (error) => {
    writeNotice(`reverse forward to ${formatLocal(local)}: ${error.message}`);
  });

  socket.on('close', () => {
    relay.close();
  });
}

function formatEnd(end: ReverseForwardEnd): string {
  if (end.kind === 'failed') {
    return `${end.code ?? 'error'}: ${end.message}`;
  }

  if (end.kind === 'closed' && end.code === CLOSE_ABNORMAL) {
    return 'could not reach impd';
  }

  if (end.kind === 'closed') {
    return `impd closed it (code ${String(end.code)})`;
  }

  return `its listener in the imp ended`;
}

async function waitForNothing(ms: number): Promise<null> {
  await Bun.sleep(ms);

  return null;
}

// the next value, or null once `ms` passed first; `pending` keeps a read
// the timeout left open for the next call
interface StateReader {
  readonly read: (ms: number | null) => Promise<IteratorResult<ImpState> | null>;
}

function createStateReader(next: () => Promise<IteratorResult<ImpState>>): StateReader {
  let pending: Promise<IteratorResult<ImpState>> | null = null;

  return {
    read: async (ms) => {
      pending ??= next();

      const reading = pending;

      if (ms === null) {
        pending = null;

        return reading;
      }

      const result = await Promise.race([reading, waitForNothing(ms)]);

      if (result !== null) {
        pending = null;
      }

      return result;
    },
  };
}

// Resolves once the imp runs again. After a lost listener it first waits for
// the imp to leave `running`, so a forward never wakes the imp it slept: an
// imp still running after `graceMs` lost only its listener.
async function waitForWake(
  next: () => Promise<IteratorResult<ImpState>>,
  graceMs: number | null,
): Promise<void> {
  const reader = createStateReader(next);
  const deadline = graceMs === null ? null : Date.now() + graceMs;
  let left = deadline === null;

  for (;;) {
    const wait = left || deadline === null ? null : Math.max(0, deadline - Date.now());

    const result = await reader.read(wait);

    if (result === null) {
      return;
    }

    if (result.done === true) {
      throw new Error('the event stream ended');
    }

    if (result.value !== 'running') {
      left = true;
    } else if (left) {
      return;
    }
  }
}

// A reverse forward that outlives sleeps: when its listener in the imp ends,
// as a sleep ends it, it waits for the imp to wake, never waking it, and
// listens again. impd refusing it ends it for good.
export async function startReverseForward(
  config: CliConfig,
  name: string,
  spec: ReverseSpec,
  io: ReverseIo = PROCESS_IO,
): Promise<ReverseForwarding> {
  const watching = new AbortController();

  const failed = Promise.withResolvers<Error>();
  const state: { forward: ReverseForward | null } = { forward: null };
  const local = formatLocal(spec.local);

  const openForward = (): ReverseForward => {
    const forward = openReverseForward({
      baseUrl: config.url,
      token: config.token,
      name,
      guest: spec.guest,
      connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
      onConnection: (accept) => {
        openLocalRelay(accept, spec.local, io.writeNotice);
      },
    });

    state.forward = forward;

    return forward;
  };

  const waitAndListen = async (end: ReverseForwardEnd): Promise<ReverseForward> => {
    if (end.kind === 'closed') {
      await Bun.sleep(io.retryMs ?? RETRY_MS);
    }

    const graceMs = end.kind === 'lost' ? (io.lostGraceMs ?? LOST_GRACE_MS) : null;
    const states = io.watchImp(config, name, watching.signal)[Symbol.asyncIterator]();

    try {
      await waitForWake(() => states.next(), graceMs);
    } finally {
      void states.return?.();
    }

    if (watching.signal.aborted) {
      throw new Error('the forward stopped');
    }

    return openForward();
  };

  const runForward = async (first: ReverseForward): Promise<void> => {
    let forward = first;

    for (;;) {
      const end = await forward.ended;

      if (watching.signal.aborted || end.kind === 'stopped') {
        return;
      }

      if (end.kind === 'failed') {
        failed.resolve(new Error(`reverse forward to ${local}: ${formatEnd(end)}`));

        return;
      }

      io.writeNotice(
        `reverse forward to ${local}: ${formatEnd(end)}; listening again once ${name} runs`,
      );

      try {
        forward = await waitAndListen(end);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));

        if (!watching.signal.aborted) {
          failed.resolve(failure);
        }

        return;
      }

      try {
        const again = await forward.listening;

        io.writeNotice(`forwarding ${name}:${formatGuest(again)} -> ${local} again`);
      } catch {
        // `ended` says why, on the next turn
      }
    }
  };

  const first = openForward();
  let listening: ReverseListening;

  try {
    listening = await first.listening;
  } catch {
    const end = await first.ended;

    throw new Error(`reverse forward to ${local}: ${formatEnd(end)}`);
  }

  void runForward(first);

  return {
    listening,
    failed: failed.promise,
    stop: () => {
      watching.abort();
      state.forward?.stop();
    },
  };
}
