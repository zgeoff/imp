import { writeSync } from 'node:fs';
import { constants } from 'node:os';
import type { Readable } from 'node:stream';
import { openExecSession } from '@zgeoff/imp-client';
import type { ExecOutcome, ExecSessionOptions } from '@zgeoff/imp-client';
import { loadCliConfig } from './cli-config';
import { TOKEN_HINT } from './run-action';
import { UsageError } from './usage-error';

export interface ExecOptions {
  readonly name: string;
  readonly argv: readonly string[];
  readonly tty: boolean;
  readonly env?: Readonly<Record<string, string>>;
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
}

// Exit codes, as ssh and shells use them: the command's own code, 128 + n
// for a signal, 127 when it could not start, 141 (128 + SIGPIPE) when our
// output went away, and 255 when imp itself failed.
const EXEC_FAILED_CODE = 127;
const BROKEN_PIPE_CODE = 141;
const IMP_FAILED_CODE = 255;

// the first one goes to the command; a second ends the session, so the CLI
// still stops when the command ignores it or impd stopped answering
const HANDLED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

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
// and resolves with the exit code for this process.
export function runExec(options: Readonly<ExecOptions>, io: ExecIo = PROCESS_IO): Promise<number> {
  let config: ReturnType<typeof loadCliConfig>;

  try {
    config = loadCliConfig(io.env);
  } catch (error) {
    if (!(error instanceof UsageError)) {
      throw error;
    }

    console.error(`imp: ${error.message}`);

    return Promise.resolve(IMP_FAILED_CODE);
  }

  const stdin = io.stdin;
  const isRaw = options.tty && stdin.isTTY === true;
  const done = Promise.withResolvers<number>();
  const state = { ended: false, raw: false, signalled: false, draining: false };
  const size = options.tty ? readTerminalSize() : null;

  const session = openExecSession({
    baseUrl: config.url,
    token: config.token,
    start: {
      name: options.name,
      argv: options.argv,
      tty: options.tty,
      ...(options.env !== undefined && { env: { ...options.env } }),
      ...size,
    },
    onStarted: () => {
      startStdin();
    },
    onOutput: (channel, data) => {
      const fd = channel === 'stderr' ? 2 : 1;

      io.writeOutput(fd, data);
    },
    connect: io.connect ?? openWebSocket,
  });

  // runs on process.exit too, so no exit path leaves the terminal raw
  const resetTerminal = (): void => {
    if (state.raw) {
      state.raw = false;
      stdin.setRawMode?.(false);
    }
  };

  const sendResize = (): void => {
    const current = readTerminalSize();

    if (current !== null) {
      session.resize(current.cols, current.rows);
    }
  };

  const signalHandlers = HANDLED_SIGNALS.map((signal) => {
    const handleSignal = (): void => {
      // before `started`, impd would only queue the signal
      if (!session.isStarted() || state.signalled) {
        stopSession(128 + readSignalNumber(signal));

        return;
      }

      state.signalled = true;

      session.sendSignal(signal);
    };

    return [signal, handleSignal] as const;
  });

  const sendStdin = (chunk: Uint8Array): void => {
    if (session.sendStdin(chunk) || state.draining) {
      return;
    }

    void waitAndResume();
  };

  const waitAndResume = async (): Promise<void> => {
    state.draining = true;

    stdin.pause();

    await session.waitForDrain();

    state.draining = false;

    if (!state.ended) {
      stdin.resume();
    }
  };

  const sendStdinEof = (): void => {
    session.closeStdin();
  };

  // stdin goes over once the process exists; a terminal on stdin is only
  // read with a tty, as with `docker exec` without -i
  const startStdin = (): void => {
    if (stdin.isTTY === true && !options.tty) {
      session.closeStdin();

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
    session.stop();
    done.resolve(code);
  };

  process.on('exit', resetTerminal);

  for (const [signal, handler] of signalHandlers) {
    process.on(signal, handler);
  }

  const waitForOutcome = async (): Promise<void> => {
    const outcome = await session.outcome;

    stopSession(printOutcome(outcome, config.url));
  };

  void waitForOutcome();

  return done.promise;
}

// prints a line on stderr for any failure, and returns the exit code
function printOutcome(outcome: ExecOutcome, baseUrl: string): number {
  switch (outcome.kind) {
    case 'exit': {
      if (outcome.code !== null) {
        return outcome.code;
      }

      const signal = readSignalNumber(outcome.signal);

      if (signal === 0) {
        console.error(`imp: impd reported an exit with no code and no known signal`);

        return IMP_FAILED_CODE;
      }

      return 128 + signal;
    }
    case 'failed': {
      const prefix = outcome.code === null ? '' : `${outcome.code}: `;

      console.error(`imp: ${prefix}${outcome.message}`);

      return outcome.code === 'EXEC_FAILED' ? EXEC_FAILED_CODE : IMP_FAILED_CODE;
    }
    case 'unauthorized': {
      console.error(`imp: ${TOKEN_HINT}`);

      return IMP_FAILED_CODE;
    }
    case 'unreachable': {
      console.error(`imp: cannot reach impd at ${baseUrl} (${outcome.detail})`);

      return IMP_FAILED_CODE;
    }
    case 'closed': {
      console.error(`imp: exec connection closed (${outcome.reason})`);

      return IMP_FAILED_CODE;
    }
    case 'bad_message': {
      console.error(`imp: bad message from impd: ${outcome.detail}`);

      return IMP_FAILED_CODE;
    }
    case 'local_error': {
      break;
    }
  }

  // a callback threw; a reader such as `head` that went away is quiet, as
  // for a local command
  if (isBrokenPipe(outcome.error)) {
    return BROKEN_PIPE_CODE;
  }

  const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);

  console.error(`imp: ${message}`);

  return IMP_FAILED_CODE;
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
