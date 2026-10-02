import type { ImpContract } from '@imp/api';
import type { ContractRouterClient } from '@orpc/contract';
import { ExecError, toExecError } from './exec-error';
import { openExecSession } from './open-exec-session';
import type { ExecSession } from './open-exec-session';

export interface ExecOptions {
  readonly tty?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;

  // the terminal size, with a tty
  readonly cols?: number;
  readonly rows?: number;

  // closes the session, as `close()` does
  readonly signal?: Readonly<AbortSignal>;
}

export interface ExecExit {
  // null when a signal ended the process
  readonly code: number | null;
  readonly signal: string | null;
}

// One running command. The output streams end when the session does; `exit`
// rejects with an ExecError when the command did not run to its exit.
export interface ExecHandle {
  readonly started: Promise<{ readonly pid: number }>;
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
}

const TTY_SIGNAL_KEYS: Readonly<Record<string, string>> = { SIGINT: '\u0003', SIGQUIT: '\u001C' };

// The login shell from the image's /etc/passwd, else bash, else sh. Plain
// sh, because the image may have neither awk nor getent.
export const CONSOLE_SHELL = [
  'shell=',
  'while IFS=: read -r user _ _ _ _ _ login; do',
  '  if [ "$user" = root ]; then shell=$login; break; fi',
  'done < /etc/passwd',
  '[ -x "$shell" ] || shell=/bin/bash',
  '[ -x "$shell" ] || shell=/bin/sh',
  'exec "$shell" -l',
].join('\n');

// The socket authenticates with a single-use exec ticket, which works in a
// browser and in Node, whose WebSocket sends no custom headers.
export async function openExec(
  deps: Readonly<ExecDeps>,
  name: string,
  argv: readonly string[],
  options: Readonly<ExecOptions> = {},
): Promise<ExecHandle> {
  const abort = options.signal;

  abort?.throwIfAborted();
  const callOptions = abort === undefined ? {} : { signal: abort };

  const issued = await deps.rpc.exec.ticket({ name }, callOptions);

  const tty = options.tty ?? false;

  // these never reject, so a caller that reads neither `started` nor `exit`
  // sees no unhandled rejection; the handle's getters turn them into throws
  const started = Promise.withResolvers<Settled<{ pid: number }>>();
  const ended = Promise.withResolvers<Settled<ExecExit>>();
  const stdout = buildOutputStream();
  const stderr = buildOutputStream();

  const session = openExecSession({
    baseUrl: deps.baseUrl,
    token: deps.token,
    ticket: issued.ticket,
    start: {
      name,
      argv,
      tty,
      ...(options.env !== undefined && { env: options.env }),
      ...(options.cwd !== undefined && { cwd: options.cwd }),
      ...(options.cols !== undefined && { cols: options.cols }),
      ...(options.rows !== undefined && { rows: options.rows }),
    },
    onStarted: (pid) => {
      started.resolve({ value: { pid } });
    },
    onOutput: (channel, data) => {
      const target = channel === 'stderr' ? stderr : stdout;

      target.push(data);
    },
    connect: (url) => new WebSocket(url),
    ...(deps.fetch !== undefined && { fetch: deps.fetch }),
  });

  const resolveHandle = (result: Settled<ExecExit>): void => {
    stdout.end();
    stderr.end();
    abort?.removeEventListener('abort', stopSession);

    if ('error' in result) {
      started.resolve({ error: result.error });
    }

    ended.resolve(result);
  };

  // the session's outcome never settles after a stop, so the stop settles
  // the handle itself
  const stopSession = (): void => {
    session.stop();

    resolveHandle({ error: new ExecError('CLOSED', 'the exec session was closed') });
  };

  const waitForOutcome = async (): Promise<void> => {
    const outcome = await session.outcome;

    const result: Settled<ExecExit> =
      outcome.kind === 'exit'
        ? { value: { code: outcome.code, signal: outcome.signal } }
        : { error: toExecError(outcome) };

    resolveHandle(result);
  };

  abort?.addEventListener('abort', stopSession, { once: true });
  void waitForOutcome();

  return buildHandle(session, {
    started: started.promise,
    ended: ended.promise,
    tty,
    stopSession,
    streams: [stdout.stream, stderr.stream],
  });
}

type Settled<T> = { readonly value: T } | { readonly error: ExecError };

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

  if (options.stdin !== undefined) {
    await handle.write(options.stdin);
  }

  await handle.closeStdin();

  const [exit, [stdout, stderr]] = await Promise.all([handle.exit, output]);

  return { ...exit, stdout, stderr };
}

interface HandleParts {
  readonly started: Promise<Settled<{ pid: number }>>;
  readonly ended: Promise<Settled<ExecExit>>;
  readonly tty: boolean;
  readonly stopSession: () => void;
  readonly streams: readonly [ReadableStream<Uint8Array>, ReadableStream<Uint8Array>];
}

function buildHandle(session: ExecSession, parts: Readonly<HandleParts>): ExecHandle {
  const encoder = new TextEncoder();

  const waitForStart = async (): Promise<{ pid: number }> => {
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

  const write = async (data: string | Uint8Array): Promise<void> => {
    await waitForStart();

    const bytes = typeof data === 'string' ? encoder.encode(data) : data;

    if (!session.sendStdin(bytes)) {
      await session.waitForDrain();
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
    get started() {
      return waitForStart();
    },
    stdout: parts.streams[0],
    stderr: parts.streams[1],
    get exit() {
      return waitForExit();
    },
    write,
    closeStdin: async () => {
      await waitForStart();

      session.closeStdin();
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

// a stream the session pushes into; a reader that cancelled gets no more
function buildOutputStream() {
  const state: { controller: ReadableStreamDefaultController<Uint8Array> | null; open: boolean } = {
    controller: null,
    open: true,
  };

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      state.controller = controller;
    },
    cancel: () => {
      state.open = false;
    },
  });

  return {
    stream,
    push: (data: Uint8Array) => {
      if (state.open) {
        state.controller?.enqueue(data);
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

// a reader loop, not `for await`: older Safari has no async iteration on
// ReadableStream
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
