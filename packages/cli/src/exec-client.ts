import { openExecSession } from '@impz/client';
import type { ExecRequirement, ExecSession, ExecSessionOptions } from '@impz/client';
import pRetry from 'p-retry';
import { advanceExec, formatSession } from './advance-exec';
import type { ExecEvent, ExecMachine, ExecStep } from './advance-exec';
import { loadCliConfig } from './cli-config';
import type { CliConfig } from './cli-config';
import { buildProcessIO } from './command-io';
import type { CommandIO, CommandStdin } from './command-io';
import { createImpClient } from './create-imp-client';
import { findDetachKey } from './detach-key';
import { openBunWebSocket } from './open-bun-web-socket';
import { createModeWatcher } from './terminal-modes';
import { toSignalExitCode } from './to-signal-exit-code';

export interface ExecOptions {
  // the saved host `--host` named, or null
  readonly host: string | null;
  readonly name: string;
  readonly argv: readonly string[];
  readonly tty: boolean;
  readonly env?: Readonly<Record<string, string>>;

  // a session that outlives the CLI: closing it detaches (needs a tty)
  readonly session?: SessionOptions;

  // runs in the imp's agent, outside its container: `impz exec --agent`.
  // The SDK passes the start through as it is, and leaves the field out of
  // its types on purpose.
  readonly outer?: boolean;

  // what impd must ensure before it starts the command: `impz exec --require`
  readonly require?: readonly ExecRequirement[];
}

interface SessionOptions {
  readonly name: string;

  // attach to the session only; argv is not used
  readonly attachOnly: boolean;

  // the byte that detaches, read from a raw terminal; null turns it off
  readonly detachKey: number | null;

  // impd keeps the output of a session this start creates
  readonly log?: boolean;
}

// what runExec touches besides signals; tests swap it
export interface ExecIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: CommandStdin;
  readonly writeOutput: (fd: 1 | 2, data: Uint8Array) => void;
  readonly connect?: ExecSessionOptions['connect'];

  // how long a lost session is tried again, and the first pause between
  // tries; each later pause doubles, up to a cap advanceExec holds
  readonly reattachWindowMs?: number;
  readonly reattachDelayMs?: number;

  // whether another client is attached to the session; it must not wake
  // the imp
  readonly isAttachedElsewhere?: (imp: string, session: string) => Promise<boolean>;

  // the lines the CLI prints about the session itself; console.error by
  // default
  readonly printError?: (line: string) => void;

  // the clock the reattach window is judged by, and the pause between tries;
  // Date.now and Bun.sleep by default
  readonly now?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
}

// impd failed, as advanceExec reports it too
const IMP_FAILED_CODE = 255;

// ctrl-c in a raw terminal
const CTRL_C = 0x03;

// the first one goes to the command; a second ends the session, so the CLI
// still stops when the command ignores it or impd stopped answering
const HANDLED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

// impd restarts in seconds, and a wake takes less than one
const REATTACH_WINDOW_MS = 60_000;
const REATTACH_DELAY_MS = 1000;

// input typed while the session is away waits for it, up to this much
const MAX_PENDING_INPUT = 64 * 1024;

// before a replay: the terminal shows the session, not what was there
const CLEAR_SCREEN = '\u001B[H\u001B[2J';

// the command's stdio and environment, and its line for each error
export function buildExecIO(io: CommandIO): ExecIo {
  return {
    env: io.env,
    stdin: io.openStdin(),
    writeOutput: (fd, data) => {
      if (fd === 1) {
        io.writeOut(data);
      } else {
        io.writeErr(data);
      }
    },
    printError: io.printError,
  };
}

// Runs one command in an imp, wired to this process's stdio and signals,
// and resolves with the exit code for this process. A session attaches
// again by itself when impd restarts or the imp sleeps under it.
export function runExec(
  options: Readonly<ExecOptions>,
  io: ExecIo = buildExecIO(buildProcessIO()),
): Promise<number> {
  const printError = io.printError ?? console.error;
  const now = io.now ?? Date.now;
  const wait = io.wait ?? Bun.sleep;
  let config: CliConfig;

  try {
    config = loadCliConfig(io.env, options.host, printError);
  } catch (error) {
    // a usage error, or a config.json that cannot be read (EACCES, EISDIR)
    printError(`impz: ${error instanceof Error ? error.message : String(error)}`);

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

    pendingInput: [] as Uint8Array[],
    pendingBytes: 0,
  };

  // what the exec has decided so far; advanceExec moves it on each event
  let machine: ExecMachine = {
    imp: options.name,
    session: session?.name ?? null,
    config,
    windowMs: io.reattachWindowMs ?? REATTACH_WINDOW_MS,
    firstDelayMs: io.reattachDelayMs ?? REATTACH_DELAY_MS,
    started: false,
    reattachUntil: null,
    tries: 0,
  };

  const advance = (event: ExecEvent): ExecStep => {
    const transition = advanceExec(machine, event);

    machine = transition.machine;

    return transition.step;
  };

  const isAway = (): boolean => machine.reattachUntil !== null;

  const writeNotice = (text: string): void => {
    io.writeOutput(2, encoder.encode(`${isRaw ? '\r\n' : ''}impz: ${text}\r\n`));
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
            ...(session?.log === true && { log: true }),
            ...(options.outer === true && { outer: true }),
            ...(options.require !== undefined && { require: options.require }),
            ...size,
          };

    return openExecSession({
      baseUrl: config.url,
      token: config.token,
      start,
      onStarted: (started) => {
        const step = advance({ kind: 'started' });
        const wasAway = step.kind === 'attached' && step.wasAway;

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
      connect: io.connect ?? openBunWebSocket,
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
        stopSession(toSignalExitCode(signal) ?? IMP_FAILED_CODE);

        return;
      }

      state.signalled = true;

      current.session.sendSignal(signal);
    };

    return [signal, handleSignal] as const;
  });

  const handleDetachKey = (): void => {
    stopSession(0);
    printError(`impz: detached from ${formatSession(machine)}`);
  };

  const sendStdin = (chunk: Uint8Array): void => {
    const key = isRaw && session !== null ? session.detachKey : null;
    const found = key === null ? null : findDetachKey(chunk, key);
    const before = found === null ? chunk : chunk.subarray(0, found.at);

    if (isAway()) {
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
      stopSession(toSignalExitCode('SIGINT') ?? IMP_FAILED_CODE);

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
    if (state.ended || current.session !== waiting || isAway()) {
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

  const isAttachedElsewhere = io.isAttachedElsewhere ?? createAttachedCheck(config);

  const stopWith = (step: Extract<ExecStep, { kind: 'stop' }>): void => {
    stopSession(step.code);

    if (step.message !== null) {
      printError(`impz: ${step.message}`);
    }
  };

  // One attach, until its outcome: the end of the exec, or a session that is
  // away, which p-retry attaches to again after the pause advanceExec picks.
  // A terminal that was away must not take the session from a newer one.
  const runAttach = async (attempt: number): Promise<void> => {
    if (attempt > 1) {
      const elsewhere = state.ended
        ? false
        : await isAttachedElsewhere(options.name, machine.session ?? '');

      if (state.ended) {
        return;
      }

      if (elsewhere) {
        stopWith(requireStop(advance({ kind: 'taken_over' })));

        return;
      }

      current.session = openSession(true);
    }

    const outcome = await current.session.outcome;

    if (state.ended) {
      return;
    }

    const step = advance({ kind: 'outcome', outcome, now: now() });

    if (step.kind !== 'reattach') {
      stopWith(requireStop(step));

      return;
    }

    if (step.isFirst) {
      // stdin reads on, for the detach key and ctrl-c
      if (state.draining) {
        state.draining = false;

        stdin.resume();
      }

      writeNotice(`lost the connection to session ${machine.session ?? ''}; attaching again`);
    }

    throw new SessionAwayError(step.delayMs);
  };

  const waitForOutcome = async (): Promise<void> => {
    try {
      await pRetry(runAttach, {
        retries: Number.POSITIVE_INFINITY,
        minTimeout: 0,
        shouldRetry: async (context) => {
          if (!(context.error instanceof SessionAwayError)) {
            return false;
          }

          // the pause is the CLI's own, so a test drives its clock
          await wait(context.error.delayMs);

          return true;
        },
      });
    } catch (error) {
      stopSession(IMP_FAILED_CODE);
      printError(`impz: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  void waitForOutcome();

  return done.promise;
}

// a session that is away, tried again after `delayMs`
class SessionAwayError extends Error {
  override name = 'SessionAwayError';

  readonly delayMs: number;

  constructor(delayMs: number) {
    super('the session is away');

    this.delayMs = delayMs;
  }
}

function requireStop(step: ExecStep): Extract<ExecStep, { kind: 'stop' }> {
  if (step.kind !== 'stop') {
    throw new Error(`advanceExec gave ${step.kind} where it ends the exec`);
  }

  return step;
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

// null when stdout is no terminal or reports no size (a pty nobody sized)
function readTerminalSize(): { cols: number; rows: number } | null {
  const cols = process.stdout.columns;
  const rows = process.stdout.rows;

  return process.stdout.isTTY && cols > 0 && rows > 0 ? { cols, rows } : null;
}
