import { writeSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { isatty } from 'node:tty';
import type { ProgressOutput } from './cp/copy-progress';
import type { CliEnv } from './host-store';

// what a command reads keys or bytes from: process.stdin, or a test's stream
export type CommandStdin = Pick<Readable, 'on' | 'off' | 'pause' | 'resume'> & {
  readonly isTTY?: boolean;
  readonly setRawMode?: (mode: boolean) => unknown;
};

// Everything a command reads from or writes to its process, so a test runs
// the command in its own process with its own streams and environment.
export interface CommandIO {
  readonly env: CliEnv;

  // one line on stdout or stderr, as console.log prints it
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;

  // bytes or text on stdout or stderr as they are, with no newline added
  readonly writeOut: (chunk: string | Uint8Array) => void;
  readonly writeErr: (chunk: string | Uint8Array) => void;

  // whether stdin is a terminal a prompt can read keys from, and whether
  // stderr is one a progress line can redraw
  readonly isStdinTerminal: boolean;
  readonly isStderrTerminal: boolean;

  // all of stdin once it ends, for input piped in
  readonly readStdin: () => Promise<string>;

  // stdin as a stream, opened when a command first asks
  readonly openStdin: () => CommandStdin;
}

// The process's own streams and environment. Nothing opens stdin until a
// command asks, as an open stdin keeps the process alive. Raw writes go out
// whole and at once, so `impz exec` keeps the order of stdout and stderr.
export function buildProcessIO(): CommandIO {
  const encoder = new TextEncoder();

  return {
    env: process.env,
    print: (line) => {
      console.log(line);
    },
    printError: (line) => {
      console.error(line);
    },
    writeOut: (chunk) => {
      writeFully(1, toBytes(encoder, chunk));
    },
    writeErr: (chunk) => {
      writeFully(2, toBytes(encoder, chunk));
    },
    isStdinTerminal: isatty(0),
    isStderrTerminal: isatty(2),
    readStdin: () => Bun.stdin.text(),
    openStdin: () => process.stdin,
  };
}

// where a command draws its progress: stderr, redrawn on a terminal
export function toProgressOutput(io: CommandIO): ProgressOutput {
  return { isTTY: io.isStderrTerminal, write: io.writeErr };
}

function toBytes(encoder: TextEncoder, chunk: string | Uint8Array): Uint8Array {
  return typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
}

// a pipe that is full answers EAGAIN; the write waits for room
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
