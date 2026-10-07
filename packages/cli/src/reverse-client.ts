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
  // Reading it never wakes the imp. impd's event stream by default.
  readonly watchImp?: (
    config: CliConfig,
    name: string,
    signal: AbortSignal,
  ) => AsyncIterable<ImpState>;

  // resolves after `ms`, or at once when the signal aborts; a timer by
  // default
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
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
};

// a timer that an abort clears, so a wait left behind keeps no process alive
function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  const waited = Promise.withResolvers<void>();
  const timer = setTimeout(waited.resolve, ms);

  signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);

      waited.resolve();
    },
    { once: true },
  );

  return waited.promise;
}

// The imp's state from the event stream, which opens with every imp. The
// stream ends when impd restarts; it opens again after RETRY_MS.
async function* readImpStates(
  config: CliConfig,
  name: string,
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void>,
): AsyncGenerator<ImpState> {
  const client = createImpClient(config);
  const state = { removed: false };

  while (!signal.aborted) {
    try {
      // NOT_FOUND for an imp destroyed before the stream opened
      await client.imps.get({ name }, { signal });

      const stream = await client.events.stream(undefined, { signal });

      for await (const event of stream) {
        if (event.ev === 'ImpRemoved' && event.imp.name === name) {
          state.removed = true;
          break;
        }

        if ((event.ev === 'ImpAdded' || event.ev === 'ImpChanged') && event.imp.name === name) {
          yield event.imp.state;
        }
      }
    } catch (error) {
      // an impd that refuses the stream refuses it again; one that is down
      // or restarting answers later
      const refused = error instanceof ORPCError && error.status >= 400 && error.status < 500;

      if (signal.aborted || refused) {
        throw error;
      }
    }

    if (state.removed) {
      throw new Error(`${name} was destroyed`);
    }

    await wait(RETRY_MS, signal);
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

// the next value, or null once `timeout` settled first; a read the timeout
// left open waits for the next call, and its failure waits with it
interface StateReader {
  readonly read: (timeout: Promise<void> | null) => Promise<IteratorResult<ImpState> | null>;
}

type StateRead = IteratorResult<ImpState> | { readonly failure: unknown };

function createStateReader(next: () => Promise<IteratorResult<ImpState>>): StateReader {
  let pending: Promise<StateRead> | null = null;

  const readNext = async (): Promise<StateRead> => {
    try {
      return await next();
    } catch (error) {
      return { failure: error };
    }
  };

  const readResult = (result: Readonly<StateRead>): IteratorResult<ImpState> => {
    pending = null;

    if ('failure' in result) {
      throw result.failure;
    }

    return result;
  };

  return {
    read: async (timeout) => {
      pending ??= readNext();

      const reading = pending;

      if (timeout === null) {
        const result = await reading;

        return readResult(result);
      }

      const result = await Promise.race([reading, timeout.then(() => null)]);

      return result === null ? null : readResult(result);
    },
  };
}

// Resolves once the imp runs again. After a lost listener it first waits for
// the imp to leave `running`, so a forward never wakes the imp it slept: an
// imp still running once `grace` settles lost only its listener.
async function waitForWake(
  next: () => Promise<IteratorResult<ImpState>>,
  grace: Promise<void> | null,
): Promise<void> {
  const reader = createStateReader(next);
  let left = grace === null;

  for (;;) {
    const timeout = left ? null : grace;

    const result = await reader.read(timeout);

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

  const wait = io.wait ?? waitOrAbort;

  const watchImp =
    io.watchImp ??
    ((watched: CliConfig, impName: string, signal: AbortSignal) =>
      readImpStates(watched, impName, signal, wait));

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
      await wait(RETRY_MS, watching.signal);
    }

    // each wait has its own stream and grace, ended once the wait is over
    const waiting = new AbortController();

    const signal = AbortSignal.any([watching.signal, waiting.signal]);
    const grace = end.kind === 'lost' ? wait(LOST_GRACE_MS, signal) : null;
    const states = watchImp(config, name, signal)[Symbol.asyncIterator]();

    try {
      await waitForWake(() => states.next(), grace);
    } finally {
      waiting.abort();
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
