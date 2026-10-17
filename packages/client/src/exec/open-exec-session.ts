import {
  EXEC_CHANNELS,
  EXEC_HIGH_WATER_BYTES,
  EXEC_PATH,
  EXEC_TICKET_PARAM,
  ExecServerMessageSchema,
  decodeExecFrame,
  encodeExecFrame,
} from '@impz/api';
import type {
  DetachReason,
  ExecAttachMessageSchema,
  ExecClientMessage,
  ExecStartMessageSchema,
  SessionOutput,
} from '@impz/api';
import type { ReadonlyFields } from '@impz/shared';
import { match } from 'ts-pattern';
import type * as z from 'zod';
import { createRpcClient } from '../create-rpc-client';
import type { FeatureNeeds } from '../require-features';
import { resolveImpdWebSocketUrl } from '../resolve-impd-web-socket-url';
import { checkExecFeatures } from './check-exec-features';
import { checkImpdAccess } from './check-impd-access';

// a command to start: the start message without the tool and outer fields,
// which only impd's own clients send. A session start needs a tty, and only
// a session takes resumeFrom or log.
export type ExecStart = ReadonlyFields<
  Omit<z.input<typeof ExecStartMessageSchema>, 'type' | 'tool' | 'outer'>
>;

// attaches to a session that runs: its replay, then live output
export type ExecAttach = ReadonlyFields<Omit<z.input<typeof ExecAttachMessageSchema>, 'type'>>;

// session is null for a plain exec; created is false for an attach to a
// session that already ran
export interface ExecStarted {
  readonly pid: number;
  readonly session: string | null;
  readonly created: boolean;

  // with killGraceMs: the agent kills what is left of the process group
  // after a stop signal, and the exit arrives only once it is gone. False
  // without killGraceMs, or for an imp whose agent predates it.
  readonly groupKill: boolean;

  // where a session's data starts in its output; `none` for a plain exec,
  // an imp whose agent predates offsets, or an impd from before them
  readonly output: SessionOutput;
}

// How a session ended. Only `exit` means the command ran to the end; its
// code is null when a signal ended the process. offset, on an exit or a
// detach of a session with offsets, is the offset after the last byte got.
export type ExecOutcome =
  | {
      readonly kind: 'exit';
      readonly code: number | null;
      readonly signal: string | null;
      readonly offset?: number;
    }

  // impd refused the command: an unknown imp, no RAM budget, EXEC_FAILED, …
  | {
      readonly kind: 'failed';
      readonly code: string | null;
      readonly message: string;
      readonly data?: unknown;
    }

  // ticketRefused: the token is fine, so impd refused the exec ticket
  | { readonly kind: 'unauthorized'; readonly ticketRefused?: boolean }
  | { readonly kind: 'unreachable'; readonly detail: string }

  // impd ended a session socket; the session runs on (DetachReason)
  | { readonly kind: 'detached'; readonly reason: DetachReason; readonly offset?: number }

  // the connection dropped after the open, without an exit
  // closeCode 1012 (EXEC_CLOSE_RESTARTING) means impd is restarting
  | { readonly kind: 'closed'; readonly reason: string; readonly closeCode?: number }
  | { readonly kind: 'bad_message'; readonly detail: string }

  // a callback threw, such as EPIPE on stdout
  | { readonly kind: 'local_error'; readonly error: unknown };

// the part of a WebSocket a session uses, so impd can bridge one in process
export type ExecSocket = Pick<
  WebSocket,
  'binaryType' | 'readyState' | 'bufferedAmount' | 'send' | 'close' | 'addEventListener'
>;

export interface ExecSessionOptions {
  readonly baseUrl: string;
  readonly token: string | null;

  // from `exec.ticket`, for a socket that cannot send the bearer header
  readonly ticket?: string;
  readonly start: ExecStart | ExecAttach;
  readonly onStarted: (started: ExecStarted) => void;
  readonly onOutput: (channel: 'stdout' | 'stderr', data: Uint8Array) => void;

  // a browser WebSocket takes no headers (it uses an exec ticket), so the
  // runtime that opens the socket is the caller's choice
  readonly connect: (url: string, headers: Readonly<Record<string, string>>) => ExecSocket;

  // for the feature check before a start, and the check that tells a
  // rejected token from an unreachable impd
  readonly fetch?: (request: Request) => Promise<Response>;
}

export interface ExecSession {
  readonly outcome: Promise<ExecOutcome>;
  readonly isStarted: () => boolean;

  // false once the socket buffers more than it should: wait for drain first
  readonly sendStdin: (data: Uint8Array) => boolean;
  readonly waitForDrain: () => Promise<void>;
  readonly closeStdin: () => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly sendSignal: (signal: string) => void;

  // closes the socket, and impd then stops the process; `outcome` never
  // settles after this, so the caller picks its own exit code
  readonly stop: () => void;
}

// impd waits for `start` before it wakes the imp, so the open is quick; the
// start itself can take a cold boot, and impd bounds that on its side
const OPEN_TIMEOUT_MS = 10_000;
const DRAIN_POLL_MS = 50;

class BadMessageError extends Error {
  override name = 'BadMessageError';
}

// One command over the `/exec` WebSocket (packages/api exec-protocol), with
// no stdio and nothing Bun-only: the caller wires the socket, output, stdin
// and signals, and maps the outcome to messages and an exit code.
export function openExecSession(options: Readonly<ExecSessionOptions>): ExecSession {
  const url = resolveImpdWebSocketUrl(options.baseUrl, EXEC_PATH);

  if (options.ticket !== undefined) {
    url.searchParams.set(EXEC_TICKET_PARAM, options.ticket);
  }

  const headers: Record<string, string> =
    options.token === null ? {} : { authorization: `Bearer ${options.token}` };

  const ws = options.connect(url.href, headers);

  // asks impd what it can do, and why it refused an upgrade
  const rpc = createRpcClient({
    url: options.baseUrl,
    token: options.token,
    ...(options.fetch !== undefined && { fetch: options.fetch }),
  });

  const outcome = Promise.withResolvers<ExecOutcome>();
  const state = { opened: false, sentOpen: false, started: false, finished: false, refused: false };

  // what the caller sent after the socket opened and before the open
  // message went, as while a start that requires anything waits on impd:
  // impd refuses a resize, a signal or stdin before the start
  const held: (string | Uint8Array<ArrayBuffer>)[] = [];

  // held bytes count toward backpressure like the socket's own buffer
  let heldBytes = 0;
  const countQueuedBytes = (): number => ws.bufferedAmount + heldBytes;

  ws.binaryType = 'arraybuffer';

  const stopSocket = (): void => {
    state.finished = true;

    clearTimeout(openTimer);

    ws.close();
  };

  const resolveOutcome = (result: ExecOutcome): void => {
    if (state.finished) {
      return;
    }

    stopSocket();

    outcome.resolve(result);
  };

  const openTimer = setTimeout(() => {
    resolveOutcome({
      kind: 'unreachable',
      detail: `no answer in ${String(OPEN_TIMEOUT_MS / 1000)} s`,
    });
  }, OPEN_TIMEOUT_MS);

  const sendControl = (data: string | Uint8Array<ArrayBuffer>): void => {
    if (state.finished || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (state.sentOpen) {
      ws.send(data);
    } else {
      held.push(data);

      heldBytes += typeof data === 'string' ? data.length : data.byteLength;
    }
  };

  const handleFrame = (data: Uint8Array): void => {
    let frame: ReturnType<typeof decodeExecFrame>;

    try {
      frame = decodeExecFrame(data);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      throw new BadMessageError(detail);
    }

    if (frame.channel === EXEC_CHANNELS.stdin) {
      throw new BadMessageError('impd sent data on the stdin channel');
    }

    const channel = frame.channel === EXEC_CHANNELS.stderr ? 'stderr' : 'stdout';

    options.onOutput(channel, frame.data);
  };

  const handleControl = (text: string): void => {
    let json: unknown;

    try {
      json = JSON.parse(text);
    } catch {
      throw new BadMessageError(`not JSON: ${text.slice(0, 80)}`);
    }

    const parsed = ExecServerMessageSchema.safeParse(json);

    if (!parsed.success) {
      throw new BadMessageError(`unknown message: ${text.slice(0, 80)}`);
    }

    const message = parsed.data;

    match(message)
      .with({ type: 'started' }, (start) => {
        // a repeat would start stdin twice
        if (state.started) {
          return;
        }

        state.started = true;

        options.onStarted({
          pid: start.pid,
          session: start.session ?? null,
          created: start.created ?? false,
          groupKill: start.groupKill ?? false,
          output: start.output ?? { continuity: 'none' },
        });
      })
      .with({ type: 'exit' }, (exit) => {
        resolveOutcome({
          kind: 'exit',
          code: exit.code,
          signal: exit.signal,
          ...(exit.offset !== undefined && { offset: exit.offset }),
        });
      })
      .with({ type: 'detached' }, (detached) => {
        resolveOutcome({
          kind: 'detached',
          reason: detached.reason,
          ...(detached.offset !== undefined && { offset: detached.offset }),
        });
      })

      // only a tool exec gets acks (openToolExec)
      .with({ type: 'stdin_ack' }, () => {})
      .with({ type: 'error' }, (failure) => {
        resolveOutcome({
          kind: 'failed',
          code: failure.code ?? null,
          message: failure.message,
          ...(failure.data !== undefined && { data: failure.data }),
        });
      })
      .exhaustive();
  };

  // a start that requires anything, or drops CAP_SYS_ADMIN, waits for impd
  // to say it reads the field
  const sendOpen = async (): Promise<void> => {
    const start = options.start;

    const needs: FeatureNeeds = {
      ...('argv' in start &&
        start.require !== undefined &&
        start.require.length > 0 && {
          execRequire: 'run the command without checking its requirements',
        }),
      ...('argv' in start &&
        start.dropSysAdmin === true && { execDropSysAdmin: 'run the command with CAP_SYS_ADMIN' }),
    };

    const refusal = await checkExecFeatures(rpc, needs);

    if (refusal !== null) {
      resolveOutcome(refusal);

      return;
    }

    if (state.finished || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    ws.send(JSON.stringify(buildOpenMessage(start)));

    state.sentOpen = true;
    heldBytes = 0;

    for (const data of held.splice(0)) {
      ws.send(data);
    }
  };

  ws.addEventListener('open', () => {
    state.opened = true;

    clearTimeout(openTimer);
    void sendOpen();
  });

  // a throw here would escape to the event loop and leave the session (and
  // a raw terminal) hanging, so every failure ends the session instead
  ws.addEventListener('message', (event) => {
    if (state.finished) {
      return;
    }

    try {
      if (event.data instanceof ArrayBuffer) {
        handleFrame(new Uint8Array(event.data));
      } else {
        handleControl(String(event.data));
      }
    } catch (error) {
      const failure: ExecOutcome =
        error instanceof BadMessageError
          ? { kind: 'bad_message', detail: error.message }
          : { kind: 'local_error', error };

      resolveOutcome(failure);
    }
  });

  // Bun reports a refused upgrade (a 401 among others) as an error and a
  // close with no HTTP status, and Node's undici as an error alone, so the
  // first of either before `open` asks impd why
  const resolveRefusal = async (reason: string): Promise<void> => {
    if (state.refused) {
      return;
    }

    state.refused = true;

    const access = await checkImpdAccess(rpc);

    if (access === 'unauthorized') {
      resolveOutcome({ kind: 'unauthorized' });
    } else if (access === 'reachable' && options.ticket !== undefined) {
      resolveOutcome({ kind: 'unauthorized', ticketRefused: true });
    } else if (access === 'unreachable') {
      resolveOutcome({ kind: 'unreachable', detail: reason });
    } else {
      resolveOutcome({ kind: 'closed', reason });
    }
  };

  ws.addEventListener('error', () => {
    if (!state.opened && !state.finished) {
      void resolveRefusal('the connection failed');
    }
  });

  ws.addEventListener('close', (event) => {
    if (state.finished) {
      return;
    }

    const reason = event.reason === '' ? `code ${String(event.code)}` : event.reason;

    if (state.opened) {
      resolveOutcome({ kind: 'closed', reason, closeCode: event.code });

      return;
    }

    void resolveRefusal(reason);
  });

  const waitForDrain = async (): Promise<void> => {
    while (!state.finished && countQueuedBytes() > EXEC_HIGH_WATER_BYTES) {
      await new Promise((resolve) => {
        setTimeout(resolve, DRAIN_POLL_MS);
      });
    }
  };

  return {
    outcome: outcome.promise,
    isStarted: () => state.started,
    sendStdin: (data) => {
      sendControl(encodeExecFrame(EXEC_CHANNELS.stdin, data));

      return countQueuedBytes() <= EXEC_HIGH_WATER_BYTES;
    },
    waitForDrain,
    closeStdin: () => {
      sendControl(JSON.stringify({ type: 'stdin_eof' } satisfies ExecClientMessage));
    },
    resize: (cols, rows) => {
      sendControl(JSON.stringify({ type: 'resize', cols, rows } satisfies ExecClientMessage));
    },
    sendSignal: (signal) => {
      sendControl(JSON.stringify({ type: 'signal', signal } satisfies ExecClientMessage));
    },
    stop: () => {
      stopSocket();
    },
  };
}

function buildOpenMessage(start: Readonly<ExecStart | ExecAttach>): ExecClientMessage {
  if ('argv' in start) {
    const { require: requirements, ...rest } = start;

    return {
      type: 'start',
      ...rest,
      argv: [...start.argv],
      ...(requirements !== undefined && { require: [...requirements] }),
    };
  }

  return { type: 'attach', ...start };
}
