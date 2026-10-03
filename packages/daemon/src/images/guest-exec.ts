import type { AgentExecRequest, ExecStream } from '../agent-client/exec-stream';

// the most of a step's stdout impd keeps when nothing streams it, and of its
// stderr, from the end
const STDOUT_MAX_BYTES = 1024 ** 2;
const STDERR_TAIL_BYTES = 64 * 1024;

// SIGKILL, to the step's process group
const SIGKILL = 9;

interface GuestRun {
  readonly exitCode: number;
  readonly stdout: string;

  // its last STDERR_TAIL_BYTES
  readonly stderr: string;
}

interface GuestRunOptions {
  // a file the step reads as its stdin, sent at the pace the guest takes it
  readonly stdinPath?: string;

  // each stdout chunk, awaited before the next is read; stdout is then not
  // kept
  readonly onStdout?: (chunk: Uint8Array) => Promise<void>;

  // a step that does not exit by then is killed
  readonly timeoutMs?: number;
  readonly signal: AbortSignal;
}

// one command in the builder, as root
export type GuestExec = (argv: readonly string[], options: GuestRunOptions) => Promise<GuestRun>;

// The step's stdout grew past what impd keeps
export class GuestOutputError extends Error {
  override readonly name = 'GuestOutputError';
}

// the last maxBytes of what is written
function createTail(maxBytes: number) {
  const chunks: Uint8Array[] = [];
  const held = { bytes: 0 };

  return {
    writeChunk: (chunk: Uint8Array): void => {
      chunks.push(chunk);

      held.bytes += chunk.byteLength;

      while (held.bytes - (chunks[0]?.byteLength ?? 0) >= maxBytes) {
        held.bytes -= chunks.shift()?.byteLength ?? 0;
      }
    },
    readText: (): string => Buffer.concat(chunks).toString('utf8').slice(-maxBytes),
  };
}

// the file into the step's stdin; the error that stopped it, else null
async function sendStdin(
  stream: Readonly<ExecStream>,
  path: string,
  signal: AbortSignal,
): Promise<Error | null> {
  try {
    for await (const chunk of Bun.file(path).stream() as AsyncIterable<Uint8Array>) {
      signal.throwIfAborted();
      stream.writeStdin(chunk);

      await stream.stdinDrained();
    }

    stream.closeStdin();

    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

// Runs each step through `open`, which reaches the builder's agent: stdin
// from a file, stdout kept or streamed, stderr's tail kept.
export function createGuestExec(
  open: (request: AgentExecRequest) => Promise<ExecStream>,
): GuestExec {
  return async (argv, options) => {
    options.signal.throwIfAborted();

    const stream = await open({ argv: [...argv], tty: false, user: '0' });

    const stopStep = () => {
      stream.sendSignal(SIGKILL);
      stream.close();
    };

    options.signal.addEventListener('abort', stopStep, { once: true });

    const timeout = { hit: false };

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timeout.hit = true;

            stopStep();
          }, options.timeoutMs);

    try {
      // the step may write while it reads: a build's log flows as its
      // context goes in
      const sending =
        options.stdinPath === undefined
          ? Promise.resolve(null)
          : sendStdin(stream, options.stdinPath, options.signal);

      const stdout: Uint8Array[] = [];
      const stderr = createTail(STDERR_TAIL_BYTES);
      const kept = { bytes: 0 };

      const collectStdout = (data: Uint8Array): Promise<void> => {
        kept.bytes += data.byteLength;

        if (kept.bytes > STDOUT_MAX_BYTES) {
          throw new GuestOutputError(
            `${argv.join(' ')}: wrote more than ${String(STDOUT_MAX_BYTES)} bytes`,
          );
        }

        stdout.push(data);

        return Promise.resolve();
      };

      const takeStdout = options.onStdout ?? collectStdout;

      for await (const event of stream.events()) {
        if (event.type === 'stderr') {
          stderr.writeChunk(event.data);
        } else if (event.type === 'stdout') {
          await takeStdout(event.data);
        } else if (event.type === 'exit') {
          const sendError = await sending;

          if (sendError !== null) {
            throw sendError;
          }

          options.signal.throwIfAborted();

          return {
            exitCode: event.signal === 0 ? event.code : 128 + event.signal,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: stderr.readText(),
          };
        }
      }

      options.signal.throwIfAborted();

      if (timeout.hit) {
        throw new Error(`${argv.join(' ')}: no exit in ${String(options.timeoutMs)} ms`);
      }

      throw new Error(`${argv.join(' ')}: the builder's agent closed the exec before its exit`);
    } finally {
      clearTimeout(timer);

      options.signal.removeEventListener('abort', stopStep);
      stream.close();
    }
  };
}
