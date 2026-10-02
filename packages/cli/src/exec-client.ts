import { writeSync } from 'node:fs';
import { constants } from 'node:os';
import type { Readable } from 'node:stream';
import { EXEC_CLOSE_RESTARTING } from '@imp/api';
import { openExecSession } from '@zgeoff/imp-client';
import type { ExecOutcome, ExecSession, ExecSessionOptions } from '@zgeoff/imp-client';
import { loadCliConfig } from './cli-config';
import type { CliConfig } from './cli-config';
import { formatUnauthorized } from './run-action';
import { createModeWatcher } from './terminal-modes';

export interface ExecOptions {
  // the saved host `--host` named, or null
  readonly host: string | null;
  readonly name: string;
  readonly argv: readonly string[];
  readonly tty: boolean;
  readonly env?: Readonly<Record<string, string>>;

  // a session that outlives the CLI: closing it detaches (needs a tty)
  readonly session?: SessionOptions;
}

interface SessionOptions {
  readonly name: string;

  // attach to the session only; argv is not used
  readonly attachOnly: boolean;

  // the byte that detaches, read from a raw terminal; null turns it off
  readonly detachKey: number | null;
}

// what runExec touches besides signals; tests swap it
export interface ExecIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: Pick<Readable, 'on' | 'off' | 'pause' | 'resume'> & {
    readonly isTTY?: boolean;
    readonly setRawMode?: (mode: boolean) => unknown;
  };
  readonly writeOutput: (fd: 1 | 2, data: Uint8Array) => void;
  readonly connect?: ExecSessionOptions['connect'];

  // how long a lost session is tried again, and the pause between tries
  readonly reattachWindowMs?: number;
  readonly reattachDelayMs?: number;
}

// Exit codes, as ssh and shells use them: the command's own code, 128 + n
// for a signal, 127 when it could not start, 141 (128 + SIGPIPE) when our
// output went away, and 255 when imp itself failed. A detach exits 0.
const EXEC_FAILED_CODE = 127;
const BROKEN_PIPE_CODE = 141;
const IMP_FAILED_CODE = 255;

// the first one goes to the command; a second ends the session, so the CLI
// still stops when the command ignores it or impd stopped answering
const HANDLED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

// impd restarts in seconds, and a wake takes less than one
const REATTACH_WINDOW_MS = 60_000;
const REATTACH_DELAY_MS = 1000;

// before a replay: the terminal shows the session, not what was there
const CLEAR_SCREEN = '\u001B[H\u001B[2J';

const PROCESS_IO: ExecIo = {
  env: process.env,
  stdin: process.stdin,
  writeOutput: (fd, data) => {
    writeFully(fd, data);
  },
};

// Bun's WebSocket takes headers, so the token stays out of the URL
function openWebSocket(url: string, headers: Readonly<Record<string, string>>): WebSocket {
  return new WebSocket(url, { headers: { ...headers } });
}

// Runs one command in an imp, wired to this process's stdio and signals,
// and resolves with the exit code for this process. A session attaches
// again by itself when impd restarts or the imp sleeps under it.
export function runExec(options: Readonly<ExecOptions>, io: ExecIo = PROCESS_IO): Promise<number> {
  let config: CliConfig;

  try {
    config = loadCliConfig(io.env, options.host);
  } catch (error) {
    // a usage error, or a config.json that cannot be read (EACCES, EISDIR)
    console.error(`imp: ${error instanceof Error ? error.message : String(error)}`);

    return Promise.resolve(IMP_FAILED_CODE);
  }

  const stdin = io.stdin;
  const session = options.session ?? null;
  const isRaw = options.tty && stdin.isTTY === true;

  const encoder = new TextEncoder();

  const modes = createModeWatcher();
  const done = Promise.withResolvers<number>();

  const state = {
    ended: false,
    raw: false,
    signalled: false,
    draining: false,
    stdinStarted: false,

    // set while a lost session is being attached again
    reattachUntil: null as number | null,
  };

  const writeNotice = (text: string): void => {
    io.writeOutput(2, encoder.encode(`${isRaw ? '\r\n' : ''}imp: ${text}\r\n`));
  };

  const openSession = (attach: boolean): ExecSession => {
    const size = options.tty ? readTerminalSize() : null;

    const start =
      attach && session !== null
        ? { name: options.name, session: session.name, ...size }
        : {
            name: options.name,
            argv: options.argv,
            tty: options.tty,
            ...(options.env !== undefined && { env: { ...options.env } }),
            ...(session !== null && { session: session.name }),
            ...size,
          };

    return openExecSession({
      baseUrl: config.url,
      token: config.token,
      start,
      onStarted: (started) => {
        state.reattachUntil = null;

        if (isRaw && !started.created && started.session !== null) {
          io.writeOutput(1, encoder.encode(CLEAR_SCREEN));
        }

        startStdin();
      },
      onOutput: (channel, data) => {
        if (isRaw) {
          modes.observe(data);
        }

        const fd = channel === 'stderr' ? 2 : 1;

        io.writeOutput(fd, data);
      },
      connect: io.connect ?? openWebSocket,
    });
  };

  const current = { session: openSession(session?.attachOnly ?? false) };

  // runs on process.exit too, so no exit path leaves the terminal raw or in
  // a program's modes
  const resetTerminal = (): void => {
    if (!state.raw) {
      return;
    }

    state.raw = false;

    // raw mode first: a write that throws or exits must not leave it on
    stdin.setRawMode?.(false);

    try {
      io.writeOutput(1, encoder.encode(modes.buildReset()));
    } catch {
      // the terminal went away; nothing to reset
    }
  };

  const sendResize = (): void => {
    const size = readTerminalSize();

    if (size !== null) {
      current.session.resize(size.cols, size.rows);
    }
  };

  const signalHandlers = HANDLED_SIGNALS.map((signal) => {
    const handleSignal = (): void => {
      // a session outlives the CLI: a hangup or a kill detaches from it.
      // Before `started`, impd would only queue the signal.
      if (session !== null || !current.session.isStarted() || state.signalled) {
        stopSession(128 + readSignalNumber(signal));

        return;
      }

      state.signalled = true;

      current.session.sendSignal(signal);
    };

    return [signal, handleSignal] as const;
  });

  const handleDetachKey = (): void => {
    stopSession(0);

    console.error(`imp: detached from ${formatSession(options.name, session?.name ?? '')}`);
  };

  const sendStdin = (chunk: Uint8Array): void => {
    const key = isRaw && session !== null ? session.detachKey : null;
    const at = key === null ? -1 : chunk.indexOf(key);

    if (at !== -1) {
      if (at > 0) {
        current.session.sendStdin(chunk.subarray(0, at));
      }

      handleDetachKey();

      return;
    }

    if (current.session.sendStdin(chunk) || state.draining) {
      return;
    }

    void waitAndResume();
  };

  const waitAndResume = async (): Promise<void> => {
    state.draining = true;

    stdin.pause();

    await current.session.waitForDrain();

    state.draining = false;

    if (!state.ended) {
      stdin.resume();
    }
  };

  const sendStdinEof = (): void => {
    current.session.closeStdin();
  };

  // stdin goes over once the process exists; a terminal on stdin is only
  // read with a tty, as with `docker exec` without -i. A session attached
  // again keeps the stdin it had.
  const startStdin = (): void => {
    if (state.stdinStarted) {
      return;
    }

    state.stdinStarted = true;

    if (stdin.isTTY === true && !options.tty) {
      current.session.closeStdin();

      return;
    }

    if (isRaw) {
      stdin.setRawMode?.(true);
      state.raw = true;

      process.on('SIGWINCH', sendResize);
    }

    stdin.on('data', sendStdin);
    stdin.on('end', sendStdinEof);
    stdin.resume();
  };

  const stopSession = (code: number): void => {
    if (state.ended) {
      return;
    }

    state.ended = true;

    resetTerminal();

    process.off('exit', resetTerminal);
    process.off('SIGWINCH', sendResize);

    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }

    stdin.off('data', sendStdin);
    stdin.off('end', sendStdinEof);
    stdin.pause();
    current.session.stop();
    done.resolve(code);
  };

  process.on('exit', resetTerminal);

  for (const [signal, handler] of signalHandlers) {
    process.on(signal, handler);
  }

  // whether the outcome leaves the session running, so the CLI may attach
  // again: never after another client took it over
  const canReattach = (outcome: ExecOutcome): boolean => {
    if (session === null) {
      return false;
    }

    if (state.reattachUntil !== null) {
      return Date.now() < state.reattachUntil && outcome.kind !== 'failed';
    }

    return (
      (outcome.kind === 'detached' && outcome.reason === 'lost') ||
      (outcome.kind === 'closed' && outcome.closeCode === EXEC_CLOSE_RESTARTING)
    );
  };

  const waitForOutcome = async (): Promise<void> => {
    for (;;) {
      const outcome = await current.session.outcome;

      if (state.ended) {
        return;
      }

      if (!canReattach(outcome)) {
        const result = buildOutcomeResult(
          outcome,
          config,
          formatSession(options.name, session?.name ?? ''),
        );

        stopSession(result.code);

        if (result.message !== null) {
          console.error(`imp: ${result.message}`);
        }

        return;
      }

      if (state.reattachUntil === null) {
        state.reattachUntil = Date.now() + (io.reattachWindowMs ?? REATTACH_WINDOW_MS);

        writeNotice(`lost the connection to session ${session?.name ?? ''}; attaching again`);
      }

      await Bun.sleep(io.reattachDelayMs ?? REATTACH_DELAY_MS);

      if (state.ended) {
        return;
      }

      current.session = openSession(true);
    }
  };

  void waitForOutcome();

  return done.promise;
}

function formatSession(imp: string, session: string): string {
  return `session ${session} (imp attach ${imp} ${session})`;
}

interface OutcomeResult {
  readonly code: number;

  // the line for stderr, printed once the terminal is reset
  readonly message: string | null;
}

// the exit code for an outcome, and the line that explains a failure
function buildOutcomeResult(
  outcome: ExecOutcome,
  config: CliConfig,
  session: string,
): OutcomeResult {
  switch (outcome.kind) {
    case 'exit': {
      if (outcome.code !== null) {
        return { code: outcome.code, message: null };
      }

      const signal = readSignalNumber(outcome.signal);

      if (signal === 0) {
        return {
          code: IMP_FAILED_CODE,
          message: 'impd reported an exit with no code and no known signal',
        };
      }

      return { code: 128 + signal, message: null };
    }
    case 'failed': {
      const prefix = outcome.code === null ? '' : `${outcome.code}: `;
      const code = outcome.code === 'EXEC_FAILED' ? EXEC_FAILED_CODE : IMP_FAILED_CODE;

      return { code, message: `${prefix}${outcome.message}` };
    }
    case 'detached': {
      if (outcome.reason === 'taken_over') {
        return { code: 0, message: `another client attached to ${session}` };
      }

      const why =
        outcome.reason === 'slow' ? 'this terminal fell behind' : 'the connection was lost';

      return { code: IMP_FAILED_CODE, message: `detached, ${why}: ${session}` };
    }
    case 'unauthorized': {
      return { code: IMP_FAILED_CODE, message: formatUnauthorized(config) };
    }
    case 'unreachable': {
      return {
        code: IMP_FAILED_CODE,
        message: `cannot reach impd at ${config.url} (${outcome.detail})`,
      };
    }
    case 'closed': {
      return { code: IMP_FAILED_CODE, message: `exec connection closed (${outcome.reason})` };
    }
    case 'bad_message': {
      return { code: IMP_FAILED_CODE, message: `bad message from impd: ${outcome.detail}` };
    }
    case 'local_error': {
      break;
    }
  }

  // a callback threw; a reader such as `head` that went away is quiet, as
  // for a local command
  if (isBrokenPipe(outcome.error)) {
    return { code: BROKEN_PIPE_CODE, message: null };
  }

  const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);

  return { code: IMP_FAILED_CODE, message };
}

// null when stdout is no terminal or reports no size (a pty nobody sized)
function readTerminalSize(): { cols: number; rows: number } | null {
  const cols = process.stdout.columns;
  const rows = process.stdout.rows;

  return process.stdout.isTTY && cols > 0 && rows > 0 ? { cols, rows } : null;
}

// synchronous, so output is on the terminal before the exit code returns
function writeFully(fd: number, data: Uint8Array): void {
  let offset = 0;

  while (offset < data.byteLength) {
    try {
      offset += writeSync(fd, data, offset);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EAGAIN')) {
        throw error;
      }

      Bun.sleepSync(1);
    }
  }
}

function isBrokenPipe(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPIPE';
}

// impd names a signal Node does not know (a real-time one) `SIG<n>`
function readSignalNumber(signal: string | null): number {
  if (signal === null) {
    return 0;
  }

  const signals: Readonly<Record<string, number>> = constants.signals;
  const numbered = /^SIG(?<number>\d+)$/.exec(signal)?.groups?.['number'];

  return signals[signal] ?? (numbered === undefined ? 0 : Number(numbered));
}
