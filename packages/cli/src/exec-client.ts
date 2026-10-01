import { writeSync } from 'node:fs';
import { constants } from 'node:os';
import {
  EXEC_CHANNELS,
  EXEC_PATH,
  ExecServerMessageSchema,
  decodeExecFrame,
  encodeExecFrame,
} from '@imp/api';
import type { ExecClientMessage } from '@imp/api';
import { loadCliConfig } from './cli-config';

export interface ExecOptions {
  readonly name: string;
  readonly argv: readonly string[];
  readonly tty: boolean;
  readonly env?: Readonly<Record<string, string>>;
}

// the exit code a shell gives a command it could not start
const EXEC_FAILED_CODE = 127;
const CONNECTION_LOST_CODE = 255;
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

// Runs one command over the `/exec` WebSocket, wired to this process's
// stdio, and resolves with its exit code (128 + n for a signal).
export function runExec(options: Readonly<ExecOptions>): Promise<number> {
  const config = loadCliConfig(process.env);

  const url = new URL(EXEC_PATH, config.url);

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  const headers: Record<string, string> =
    config.token === null ? {} : { authorization: `Bearer ${config.token}` };

  const ws = new WebSocket(url.href, { headers });

  const stdin = process.stdin;
  const isRaw = options.tty && stdin.isTTY;

  ws.binaryType = 'arraybuffer';

  const sendText = (text: string): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(text);
    }
  };

  const sendResize = (): void => {
    const size = readTerminalSize();

    if (size !== null) {
      sendText(JSON.stringify({ type: 'resize', ...size } satisfies ExecClientMessage));
    }
  };

  const signalHandlers = FORWARDED_SIGNALS.map((signal) => {
    const sendSignal = (): void => {
      sendText(JSON.stringify({ type: 'signal', signal } satisfies ExecClientMessage));
    };

    return [signal, sendSignal] as const;
  });

  // stdin goes over once the process exists; a terminal on stdin is only
  // read with a tty, as with `docker exec` without -i
  const startStdin = (): void => {
    if (stdin.isTTY && !options.tty) {
      sendText(JSON.stringify({ type: 'stdin_eof' } satisfies ExecClientMessage));

      return;
    }

    if (isRaw) {
      stdin.setRawMode(true);
      process.on('SIGWINCH', sendResize);
    }

    stdin.on('data', (chunk: Uint8Array) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeExecFrame(EXEC_CHANNELS.stdin, chunk));
      }
    });

    stdin.on('end', () => {
      sendText(JSON.stringify({ type: 'stdin_eof' } satisfies ExecClientMessage));
    });

    stdin.resume();
  };

  const resetTerminal = (): void => {
    if (isRaw) {
      stdin.setRawMode(false);
    }

    process.off('SIGWINCH', sendResize);

    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }

    stdin.pause();
  };

  return new Promise((resolve) => {
    let finished = false;

    const stopSession = (code: number): void => {
      if (finished) {
        return;
      }

      finished = true;

      resetTerminal();

      ws.close();

      resolve(code);
    };

    ws.addEventListener('open', () => {
      const size = options.tty ? readTerminalSize() : null;

      sendText(
        JSON.stringify({
          type: 'start',
          name: options.name,
          argv: [...options.argv],
          tty: options.tty,
          ...(options.env !== undefined && { env: { ...options.env } }),
          ...size,
        } satisfies ExecClientMessage),
      );

      if (!options.tty) {
        for (const [signal, handler] of signalHandlers) {
          process.on(signal, handler);
        }
      }
    });

    ws.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) {
        const frame = decodeExecFrame(new Uint8Array(event.data));
        const fd = frame.channel === EXEC_CHANNELS.stderr ? 2 : 1;

        writeFully(fd, frame.data);

        return;
      }

      const message = ExecServerMessageSchema.parse(JSON.parse(String(event.data)));

      if (message.type === 'started') {
        startStdin();
      } else if (message.type === 'exit') {
        const code = message.code ?? 128 + readSignalNumber(message.signal);

        stopSession(code);
      } else {
        process.stderr.write(`imp: ${message.message}\n`);

        const code = message.code === 'EXEC_FAILED' ? EXEC_FAILED_CODE : 1;

        stopSession(code);
      }
    });

    ws.addEventListener('error', () => {
      process.stderr.write(`imp: cannot reach impd at ${url.origin}\n`);

      stopSession(CONNECTION_LOST_CODE);
    });

    ws.addEventListener('close', (event) => {
      if (!finished) {
        const reason = event.reason === '' ? `code ${String(event.code)}` : event.reason;

        process.stderr.write(`imp: exec connection closed (${reason})\n`);

        stopSession(CONNECTION_LOST_CODE);
      }
    });
  });
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

function readSignalNumber(signal: string | null): number {
  const signals: Readonly<Record<string, number>> = constants.signals;

  return signal === null ? 0 : (signals[signal] ?? 0);
}
