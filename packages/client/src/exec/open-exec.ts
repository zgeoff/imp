import { CONSOLE_SHELL } from '@imp/api';
import type { ExecRequirement, ImpContract, ResumeFrom } from '@imp/api';
import type { ContractRouterClient } from '@orpc/contract';
import { ExecError } from './exec-error';
import { openExecSession } from './open-exec-session';
import type {
  ExecAttach,
  ExecSession,
  ExecSocket,
  ExecStart,
  ExecStarted,
} from './open-exec-session';
import { toExecError } from './to-exec-error';

export interface ExecOptions {
  readonly tty?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;

  // the terminal size, with a tty
  readonly cols?: number;
  readonly rows?: number;

  // starts this session, or attaches to it if it runs; needs a tty. A
  // session outlives the handle: `close()` detaches, and `exit` rejects
  // with DETACHED when impd ends the socket while the session runs on
  readonly session?: string;

  // after a stop signal (SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGKILL), how
  // long the rest of the group gets before the agent kills it; not with a
  // tty. See ExecStarted.groupKill.
  readonly killGraceMs?: number;

  // with a session: the output after the byte at this offset of this
  // generation, rather than a replay; `started.output.resume` says how it
  // was met (docs/architecture/daemon.md#output-offsets)
  readonly resumeFrom?: ResumeFrom;

  // what impd must ensure before it starts the command, or the exec fails
  // with PRECONDITION_FAILED and nothing runs: `broker`, the broker's
  // variables and CA bundle (docs/guides/connectors.md#requiring-the-broker)
  readonly require?: readonly ExecRequirement[];

  // with a session this start creates: impd keeps its output on the host,
  // for `sessions.readLog`; `started.output.log` says whether it does. Check
  // `system.info.features.sessionLog` first (docs/guides/session-logs.md).
  readonly log?: boolean;

  // closes the session, as `close()` does; before the start, `started` and
  // `exit` reject with the abort's reason (an AbortError), as `openExec` does
  readonly signal?: Readonly<AbortSignal>;

  // output a stream may hold unread before the session ends with
  // OUTPUT_OVERFLOW (default 8 MiB); a caller reads or cancels both streams
  readonly maxUnreadBytes?: number;
}

export interface ExecExit {
  // null when a signal ended the process
  readonly code: number | null;
  readonly signal: string | null;

  // for a session with offsets: the offset after the last byte received
  readonly offset?: number;
}

// One running command. The output streams end when the session does, and
// cancelling both ends it; `exit` rejects with an ExecError when the command
// did not run to its exit, or with the abort's reason before it started.
export interface ExecHandle {
  readonly started: Promise<ExecStarted>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exit: Promise<ExecExit>;

  // waits for the start, and resolves once the socket has room again, so a
  // writer in a loop stays within the socket's buffer
  readonly write: (data: string | Uint8Array) => Promise<void>;
  readonly closeStdin: () => Promise<void>;
  readonly resize: (cols: number, rows: number) => void;

  // with a tty, SIGINT and SIGQUIT go as the terminal's keys, so they reach
  // the foreground job as a typed ^C would, not only the shell
  readonly sendSignal: (signal: string) => void;
  readonly close: () => void;
}

export interface ExecDeps {
  readonly rpc: Readonly<ContractRouterClient<ImpContract>>;
  readonly baseUrl: string;
  readonly token: string | null;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly connect?: (url: string) => ExecSocket;
}

const DEFAULT_MAX_UNREAD_BYTES = 8 * 1024 * 1024;
const TTY_SIGNAL_KEYS: Readonly<Record<string, string>> = { SIGINT: '\u0003', SIGQUIT: '\u001C' };

// The socket authenticates with a single-use exec ticket, which works in a
// browser and in Node, whose WebSocket sends no custom headers.
export function openExec(
  deps: Readonly<ExecDeps>,
  name: string,
  argv: readonly string[],
  options: Readonly<ExecOptions> = {},
): Promise<ExecHandle> {
  const tty = options.tty ?? false;

  return openHandle(deps, options, tty, {
    name,
    argv,
    tty,
    ...(options.env !== undefined && { env: options.env }),
    ...(options.cwd !== undefined && { cwd: options.cwd }),
    ...(options.cols !== undefined && { cols: options.cols }),
    ...(options.rows !== undefined && { rows: options.rows }),
    ...(options.session !== undefined && { session: options.session }),
    ...(options.killGraceMs !== undefined && { killGraceMs: options.killGraceMs }),
    ...(options.resumeFrom !== undefined && { resumeFrom: options.resumeFrom }),
    ...(options.require !== undefined && { require: options.require }),
    ...(options.log === true && { log: true }),
  });
}

export interface AttachOptions extends Pick<
  ExecOptions,
  'cols' | 'rows' | 'signal' | 'maxUnreadBytes' | 'resumeFrom'
> {
  // false: reject with InvalidStateError rather than boot or wake the imp
  readonly wake?: boolean;
}

// Attaches to a session that runs: stdout gets the replay of its recent
// output, or with resumeFrom the output after it, then live output.
// NoSessionError when there is no such session.
export function openAttach(
  deps: Readonly<ExecDeps>,
  name: string,
  session: string,
  options: Readonly<AttachOptions> = {},
): Promise<ExecHandle> {
  return openHandle(deps, options, true, {
    name,
    session,
    ...(options.cols !== undefined && { cols: options.cols }),
    ...(options.rows !== undefined && { rows: options.rows }),
    ...(options.resumeFrom !== undefined && { resumeFrom: options.resumeFrom }),
    ...(options.wake !== undefined && { wake: options.wake }),
  });
}

async function openHandle(
  deps: Readonly<ExecDeps>,
  options: Readonly<AttachOptions>,
  tty: boolean,
  start: Readonly<ExecStart | ExecAttach>,
): Promise<ExecHandle> {
  const name = start.name;
  const abort = options.signal;
  const callOptions = abort === undefined ? {} : { signal: abort };

  abort?.throwIfAborted();

  const issued = await deps.rpc.exec.ticket({ name }, callOptions);

  // the ticket call may have outlived an abort that it did not see
  abort?.throwIfAborted();
  const maxUnreadBytes = options.maxUnreadBytes ?? DEFAULT_MAX_UNREAD_BYTES;
  const started = Promise.withResolvers<Settled<ExecStarted>>();
  const ended = Promise.withResolvers<Settled<ExecExit>>();
  const state = { ended: false, cancelled: 0 };

  const stopWith = (code: 'CLOSED' | 'OUTPUT_OVERFLOW', message: string): void => {
    session.stop();

    resolveHandle({ error: new ExecError(code, message) });
  };

  const outputHooks: OutputHooks = {
    maxUnreadBytes,
    onOverflow: (channel) => {
      stopWith(
        'OUTPUT_OVERFLOW',
        `${channel} holds more than ${String(maxUnreadBytes)} unread bytes; read or cancel it`,
      );
    },

    // nobody reads the output any more, so the command may as well stop
    onCancel: () => {
      state.cancelled += 1;

      if (state.cancelled === 2) {
        stopWith('CLOSED', 'both output streams were cancelled');
      }
    },
  };

  const stdout = buildOutputStream('stdout', outputHooks);
  const stderr = buildOutputStream('stderr', outputHooks);

  const session = openExecSession({
    baseUrl: deps.baseUrl,
    token: deps.token,
    ticket: issued.ticket,
    start,
    onStarted: (info) => {
      started.resolve({ value: info });
    },
    onOutput: (channel, data) => {
      const target = channel === 'stderr' ? stderr : stdout;

      target.push(data);
    },
    connect: deps.connect ?? ((url) => new WebSocket(url)),
    ...(deps.fetch !== undefined && { fetch: deps.fetch }),
  });

  const resolveHandle = (result: Settled<ExecExit>): void => {
    if (state.ended) {
      return;
    }

    state.ended = true;

    stdout.end();
    stderr.end();
    abort?.removeEventListener('abort', stopForAbort);

    if ('error' in result) {
      started.resolve({ error: result.error });
    }

    ended.resolve(result);
  };

  // the session's outcome never settles after a stop, so the stop settles
  // the handle itself
  const stopSession = (): void => {
    stopWith('CLOSED', 'the exec session was closed');
  };

  // an abort during the connect is the caller's abort, as one during the
  // ticket call is; once the command runs, it closes the session
  const stopForAbort = (): void => {
    if (session.isStarted()) {
      stopSession();

      return;
    }

    session.stop();

    resolveHandle({ error: readAbortReason(abort) });
  };

  const waitForOutcome = async (): Promise<void> => {
    const outcome = await session.outcome;

    const result: Settled<ExecExit> =
      outcome.kind === 'exit'
        ? {
            value: {
              code: outcome.code,
              signal: outcome.signal,
              ...(outcome.offset !== undefined && { offset: outcome.offset }),
            },
          }
        : { error: toExecError(outcome) };

    resolveHandle(result);
  };

  if (abort?.aborted === true) {
    stopForAbort();
  } else {
    abort?.addEventListener('abort', stopForAbort, { once: true });
  }

  void waitForOutcome();

  return buildHandle(session, {
    started: started.promise,
    ended: ended.promise,
    isEnded: () => state.ended,
    tty,
    stopSession,
    streams: [stdout.stream, stderr.stream],
  });
}

type Settled<T> = { readonly value: T } | { readonly error: Error };

function readAbortReason(abort: Readonly<AbortSignal> | undefined): Error {
  const reason: unknown = abort?.reason;

  return reason instanceof Error ? reason : new DOMException('the exec was aborted', 'AbortError');
}

export type ConsoleOptions = Omit<ExecOptions, 'tty'>;

// A login shell with a tty, as `imp console` opens. TERM defaults to
// xterm-256color, what xterm.js and most terminals speak.
export function openConsole(
  deps: Readonly<ExecDeps>,
  name: string,
  options: Readonly<ConsoleOptions> = {},
): Promise<ExecHandle> {
  return openExec(deps, name, ['/bin/sh', '-c', CONSOLE_SHELL], {
    ...options,
    tty: true,
    env: options.env ?? { TERM: 'xterm-256color' },
  });
}

export interface RunResult extends ExecExit {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export interface RunOptions extends Omit<ExecOptions, 'tty' | 'cols' | 'rows'> {
  // sent, then stdin closes; without it, stdin closes at once
  readonly stdin?: string | Uint8Array;
}

// Runs a command to its exit and collects its output. Both streams drain at
// once: a command that fills stderr while the caller waits on stdout would
// otherwise stall.
export async function runCommand(
  deps: Readonly<ExecDeps>,
  name: string,
  argv: readonly string[],
  options: Readonly<RunOptions> = {},
): Promise<RunResult> {
  const handle = await openExec(deps, name, argv, options);

  const output = Promise.all([readAll(handle.stdout), readAll(handle.stderr)]);

  // a command that exits before it reads its stdin still returns its exit
  // and output: `exit` reports how it ended
  if (options.stdin !== undefined) {
    await handle.write(options.stdin).catch(checkWriteFailure);
  }

  await handle.closeStdin();

  const [exit, [stdout, stderr]] = await Promise.all([handle.exit, output]);

  return { ...exit, stdout, stderr };
}

// stdin goes in frames of at most this: impd, as Bun serves it, closes a
// socket that sends one frame over 16 MiB
const STDIN_FRAME_BYTES = 1024 ** 2;

// a write to a command that already exited, which `exit` reports instead
function checkWriteFailure(error: unknown): void {
  if (!(error instanceof ExecError && error.code === 'CLOSED')) {
    throw error;
  }
}

interface HandleParts {
  readonly started: Promise<Settled<ExecStarted>>;
  readonly ended: Promise<Settled<ExecExit>>;
  readonly isEnded: () => boolean;
  readonly tty: boolean;
  readonly stopSession: () => void;
  readonly streams: readonly [ReadableStream<Uint8Array>, ReadableStream<Uint8Array>];
}

function buildHandle(session: ExecSession, parts: Readonly<HandleParts>): ExecHandle {
  const encoder = new TextEncoder();

  const waitForStart = async (): Promise<ExecStarted> => {
    const result = await parts.started;

    if ('error' in result) {
      throw result.error;
    }

    return result.value;
  };

  const waitForExit = async (): Promise<ExecExit> => {
    const result = await parts.ended;

    if ('error' in result) {
      throw result.error;
    }

    return result.value;
  };

  // made once, so every read of `started` and `exit` is the same promise;
  // a caller that reads neither sees no unhandled rejection
  const startedPromise = waitForStart();
  const exitPromise = waitForExit();

  void waitIgnoringRejection(startedPromise);
  void waitIgnoringRejection(exitPromise);

  // what ended the session, when it failed: a write after it says why
  const end: { error: Error | null } = { error: null };

  void (async () => {
    const result = await parts.ended;

    if ('error' in result) {
      end.error = result.error;
    }
  })();

  const requireOpen = (): void => {
    if (!parts.isEnded()) {
      return;
    }

    throw end.error ?? new ExecError('CLOSED', 'the exec session has ended');
  };

  const write = async (data: string | Uint8Array): Promise<void> => {
    requireOpen();

    await startedPromise;

    requireOpen();

    const bytes = typeof data === 'string' ? encoder.encode(data) : data;

    for (let sent = 0; sent < bytes.byteLength; sent += STDIN_FRAME_BYTES) {
      requireOpen();

      if (!session.sendStdin(bytes.subarray(sent, sent + STDIN_FRAME_BYTES))) {
        await session.waitForDrain();
      }
    }
  };

  // a key for a session that already ended goes nowhere, as a signal would
  const sendKey = async (key: string): Promise<void> => {
    try {
      await write(key);
    } catch {
      // the session ended; `exit` reports why
    }
  };

  return {
    started: startedPromise,
    stdout: parts.streams[0],
    stderr: parts.streams[1],
    exit: exitPromise,
    write,

    // stdin of a command that already exited is closed: nothing to send
    closeStdin: async () => {
      await startedPromise;

      if (!parts.isEnded()) {
        session.closeStdin();
      }
    },
    resize: (cols, rows) => {
      session.resize(cols, rows);
    },
    sendSignal: (signal) => {
      const key = parts.tty ? TTY_SIGNAL_KEYS[signal] : undefined;

      if (key === undefined) {
        session.sendSignal(signal);
      } else {
        void sendKey(key);
      }
    },
    close: parts.stopSession,
  };
}

async function waitIgnoringRejection(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // the caller sees the rejection where it reads the promise
  }
}

interface OutputHooks {
  readonly maxUnreadBytes: number;
  readonly onOverflow: (channel: 'stdout' | 'stderr') => void;
  readonly onCancel: () => void;
}

// A stream the session pushes into. The queue counts bytes, so its
// desiredSize goes below zero once more than maxUnreadBytes wait unread.
function buildOutputStream(channel: 'stdout' | 'stderr', hooks: Readonly<OutputHooks>) {
  const state: { controller: ReadableStreamDefaultController<Uint8Array> | null; open: boolean } = {
    controller: null,
    open: true,
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        state.controller = controller;
      },
      cancel: () => {
        state.open = false;

        hooks.onCancel();
      },
    },
    { highWaterMark: hooks.maxUnreadBytes, size: (chunk) => chunk?.byteLength ?? 0 },
  );

  return {
    stream,
    push: (data: Uint8Array) => {
      if (!state.open || state.controller === null) {
        return;
      }

      state.controller.enqueue(data);

      if ((state.controller.desiredSize ?? 0) < 0) {
        hooks.onOverflow(channel);
      }
    },
    end: () => {
      if (state.open) {
        state.open = false;
        state.controller?.close();
      }
    },
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  for (;;) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    chunks.push(result.value);
  }

  const all = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));

  let offset = 0;

  for (const chunk of chunks) {
    all.set(chunk, offset);

    offset += chunk.byteLength;
  }

  return all;
}
