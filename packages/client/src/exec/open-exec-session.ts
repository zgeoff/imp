import {
  EXEC_CHANNELS,
  EXEC_PATH,
  EXEC_TICKET_PARAM,
  ExecServerMessageSchema,
  decodeExecFrame,
  encodeExecFrame,
} from '@imp/api';
import type { DetachReason, ExecClientMessage, ResumeFrom, SessionOutput } from '@imp/api';
import { resolveImpdUrl } from '../resolve-impd-url';
import { checkImpdAccess } from './check-impd-access';

export interface ExecStart {
  readonly name: string;
  readonly argv: readonly string[];
  readonly tty: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly cols?: number;
  readonly rows?: number;

  // starts this session, or attaches to it if it runs; needs a tty
  readonly session?: string;
  readonly killGraceMs?: number;

  // with a session: the output after this byte rather than a replay
  readonly resumeFrom?: ResumeFrom;
}

// attaches to a session that runs: its replay, then live output
export interface ExecAttach {
  readonly name: string;
  readonly session: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly resumeFrom?: ResumeFrom;

  // false: fail with INVALID_STATE rather than boot or wake the imp
  readonly wake?: boolean;
}

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

  // for the check that tells a rejected token from an unreachable impd
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

// the same mark impd uses for output (packages/daemon exec-session)
const HIGH_WATER_BYTES = 1_048_576;
const DRAIN_POLL_MS = 50;

class BadMessageError extends Error {
  override name = 'BadMessageError';
}

// One command over the `/exec` WebSocket (packages/api exec-protocol), with
// no stdio and nothing Bun-only: the caller wires the socket, output, stdin
// and signals, and maps the outcome to messages and an exit code.
export function openExecSession(options: Readonly<ExecSessionOptions>): ExecSession {
  const url = resolveImpdUrl(options.baseUrl, EXEC_PATH);

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  if (options.ticket !== undefined) {
    url.searchParams.set(EXEC_TICKET_PARAM, options.ticket);
  }

  const headers: Record<string, string> =
    options.token === null ? {} : { authorization: `Bearer ${options.token}` };

  const ws = options.connect(url.href, headers);
  const outcome = Promise.withResolvers<ExecOutcome>();
  const state = { opened: false, started: false, finished: false, refused: false };

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

  const sendControl = (text: string): void => {
    if (!state.finished && ws.readyState === WebSocket.OPEN) {
      ws.send(text);
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

    if (message.type === 'started') {
      // a repeat would start stdin twice
      if (state.started) {
        return;
      }

      state.started = true;

      options.onStarted({
        pid: message.pid,
        session: message.session ?? null,
        created: message.created ?? false,
        groupKill: message.groupKill ?? false,
        output: message.output ?? { continuity: 'none' },
      });
    } else if (message.type === 'exit') {
      resolveOutcome({
        kind: 'exit',
        code: message.code,
        signal: message.signal,
        ...(message.offset !== undefined && { offset: message.offset }),
      });
    } else if (message.type === 'detached') {
      resolveOutcome({
        kind: 'detached',
        reason: message.reason,
        ...(message.offset !== undefined && { offset: message.offset }),
      });
    } else if (message.type === 'stdin_ack') {
      // only a tool exec gets acks, and this client starts none
    } else {
      resolveOutcome({
        kind: 'failed',
        code: message.code ?? null,
        message: message.message,
        ...(message.data !== undefined && { data: message.data }),
      });
    }
  };

  ws.addEventListener('open', () => {
    state.opened = true;

    clearTimeout(openTimer);
    sendControl(JSON.stringify(buildOpenMessage(options.start)));
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

    const access = await checkImpdAccess(options.baseUrl, options.token, options.fetch);

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
    while (!state.finished && ws.bufferedAmount > HIGH_WATER_BYTES) {
      await new Promise((resolve) => {
        setTimeout(resolve, DRAIN_POLL_MS);
      });
    }
  };

  return {
    outcome: outcome.promise,
    isStarted: () => state.started,
    sendStdin: (data) => {
      if (!state.finished && ws.readyState === WebSocket.OPEN) {
        ws.send(encodeExecFrame(EXEC_CHANNELS.stdin, data));
      }

      return ws.bufferedAmount <= HIGH_WATER_BYTES;
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
    return { type: 'start', ...start, argv: [...start.argv] };
  }

  return { type: 'attach', ...start };
}
