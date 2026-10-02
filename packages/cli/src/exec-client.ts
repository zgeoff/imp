import { writeSync } from 'node:fs';
import { constants } from 'node:os';
import type { Readable } from 'node:stream';
import { openExecSession } from '@zgeoff/imp-client';
import type { ExecOutcome, ExecSession, ExecSessionOptions } from '@zgeoff/imp-client';
import { loadCliConfig } from './cli-config';
import type { CliConfig } from './cli-config';
import { createImpClient } from './create-imp-client';
import { findDetachKey } from './detach-key';
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

  // runs in the imp's agent, outside its container: `imp exec --agent`.
  // The SDK passes the start through as it is, and leaves the field out of
  // its types on purpose.
  readonly outer?: boolean;
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

  // how long a lost session is tried again, and the first pause between
  // tries; each later pause doubles, up to REATTACH_MAX_DELAY_MS
  readonly reattachWindowMs?: number;
  readonly reattachDelayMs?: number;

  // whether another client is attached to the session; it must not wake
  // the imp
  readonly isAttachedElsewhere?: (imp: string, session: string) => Promise<boolean>;
}

// Exit codes as ssh and shells use them (the README has the table): 127
// could not start, 141 our output went away, 254 another client took the
// session over, 255 imp failed. A detach exits 0.
const EXEC_FAILED_CODE = 127;

// the imp answers, but the container its commands run in is down
const INNER_DOWN_HINT =
  ' (the container in the imp starts again on its own; imp stop and imp start, or imp restore, bring it back)';

const BROKEN_PIPE_CODE = 141;
const TAKEN_OVER_CODE = 254;
const IMP_FAILED_CODE = 255;

// ctrl-c in a raw terminal, and the code SIGINT gives
const CTRL_C = 0x03;
const INTERRUPTED_CODE = 130;

// the first one goes to the command; a second ends the session, so the CLI
// still stops when the command ignores it or impd stopped answering
const HANDLED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

// impd restarts in seconds, and a wake takes less than one
const REATTACH_WINDOW_MS = 60_000;
const REATTACH_DELAY_MS = 1000;
const REATTACH_MAX_DELAY_MS = 8000;

// input typed while the session is away waits for it, up to this much
const MAX_PENDING_INPUT = 64 * 1024;

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

    // a session that never started has nothing to attach to again
    started: false,

    // set while a lost session is being attached again
    reattachUntil: null as number | null,
    reattachTries: 0,
    pendingInput: [] as Uint8Array[],
    pendingBytes: 0,
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
            ...(options.outer === true && { outer: true }),
            ...size,
          };

    return openExecSession({
      baseUrl: config.url,
      token: config.token,
      start,
      onStarted: (started) => {
        const wasAway = state.reattachUntil !== null;

        state.started = true;
        state.reattachUntil = null;
        state.reattachTries = 0;

        if (isRaw && !started.created && started.session !== null) {
          io.writeOutput(1, encoder.encode(CLEAR_SCREEN));
        }

        if (wasAway) {
          writeNotice(`attached again to session ${started.session ?? ''}`);
          sendPendingInput();
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
    const found = key === null ? null : findDetachKey(chunk, key);
    const before = found === null ? chunk : chunk.subarray(0, found.at);

    if (state.reattachUntil !== null) {
      holdInput(before);
    } else if (before.byteLength > 0) {
      sendInput(before);
    }

    if (found !== null && !state.ended) {
      handleDetachKey();
    }
  };

  const sendInput = (data: Uint8Array): void => {
    if (current.session.sendStdin(data) || state.draining) {
      return;
    }

    void waitAndResume();
  };

  // while the session is away: ctrl-c gives up, anything else waits for it
  const holdInput = (data: Uint8Array): void => {
    if (isRaw && data.includes(CTRL_C)) {
      stopSession(INTERRUPTED_CODE);

      return;
    }

    if (state.pendingBytes + data.byteLength > MAX_PENDING_INPUT) {
      return;
    }

    state.pendingInput.push(new Uint8Array(data));

    state.pendingBytes += data.byteLength;
  };

  const sendPendingInput = (): void => {
    const pending = state.pendingInput;

    state.pendingInput = [];
    state.pendingBytes = 0;

    for (const data of pending) {
      sendInput(data);
    }
  };

  const waitAndResume = async (): Promise<void> => {
    const waiting = current.session;

    state.draining = true;

    stdin.pause();

    await waiting.waitForDrain();

    // a reattach took over stdin; it reads on for the detach key
    if (state.ended || current.session !== waiting || state.reattachUntil !== null) {
      return;
    }

    state.draining = false;

    stdin.resume();
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
  // again: never after another client took it over, or once the window is
  // over
  const canReattach = (outcome: ExecOutcome): boolean => {
    if (session === null || !state.started) {
      return false;
    }

    if (state.reattachUntil !== null && Date.now() >= state.reattachUntil) {
      return false;
    }

    if (outcome.kind === 'detached') {
      return outcome.reason === 'lost' || outcome.reason === 'slow';
    }

    return outcome.kind === 'closed' || outcome.kind === 'unreachable';
  };

  const isAttachedElsewhere = io.isAttachedElsewhere ?? createAttachedCheck(config);

  // the pause before the next try: 1 s, 2 s, 4 s, then the cap
  const readReattachDelay = (): number => {
    const first = io.reattachDelayMs ?? REATTACH_DELAY_MS;

    state.reattachTries += 1;

    return Math.min(first * 2 ** (state.reattachTries - 1), REATTACH_MAX_DELAY_MS);
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

      const sessionName = session?.name ?? '';

      if (state.reattachUntil === null) {
        state.reattachUntil = Date.now() + (io.reattachWindowMs ?? REATTACH_WINDOW_MS);

        // stdin reads on, for the detach key and ctrl-c
        if (state.draining) {
          state.draining = false;

          stdin.resume();
        }

        writeNotice(`lost the connection to session ${sessionName}; attaching again`);
      }

      await Bun.sleep(readReattachDelay());

      // a terminal that was away must not take the session from a newer one
      const elsewhere = state.ended ? false : await isAttachedElsewhere(options.name, sessionName);

      if (state.ended) {
        return;
      }

      if (elsewhere) {
        stopSession(TAKEN_OVER_CODE);

        console.error(
          `imp: another client attached to ${formatSession(options.name, sessionName)}`,
        );

        return;
      }

      current.session = openSession(true);
    }
  };

  void waitForOutcome();

  return done.promise;
}

// asks impd's last view of the sessions, which never wakes the imp; when
// impd cannot answer, the attach itself finds out
function createAttachedCheck(
  config: CliConfig,
): (imp: string, session: string) => Promise<boolean> {
  return async (imp, session) => {
    try {
      const sessions = await createImpClient(config).sessions.list({ name: imp });

      return sessions.some((entry) => entry.name === session && entry.attached);
    } catch {
      return false;
    }
  };
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
      const hint = outcome.code === 'INNER_DOWN' ? INNER_DOWN_HINT : '';

      return { code, message: `${prefix}${outcome.message}${hint}` };
    }
    case 'detached': {
      if (outcome.reason === 'taken_over') {
        return { code: TAKEN_OVER_CODE, message: `another client attached to ${session}` };
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
