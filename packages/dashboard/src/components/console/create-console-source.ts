import type { ExecHandle, ImpClient } from '@zgeoff/imp-client';
import type { TerminalConnection, TerminalEnd, TerminalSource } from './terminal-source';

// A login shell in the imp, as `imp console` opens; it wakes a sleeping imp
export function createConsoleSource(
  client: Pick<ImpClient, 'openConsole'>,
  name: string,
): TerminalSource {
  return {
    label: `console on ${name}`,
    open: async (size, signal) => {
      const handle = await client.openConsole(name, { cols: size.cols, rows: size.rows, signal });

      return toTerminalConnection(handle);
    },
  };
}

export function toTerminalConnection(handle: ExecHandle): TerminalConnection {
  return {
    // a tty sends everything on stdout; stderr is read too, so it never fills
    output: mergeStreams(handle.stdout, handle.stderr),
    write: (data) => handle.write(data),
    resize: (size) => {
      handle.resize(size.cols, size.rows);
    },
    close: handle.close,
    ended: readEnd(handle),
  };
}

async function readEnd(handle: ExecHandle): Promise<TerminalEnd> {
  try {
    const exit = await handle.exit;

    return { kind: 'exit', code: exit.code, signal: exit.signal };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

// one stream with both streams' chunks in arrival order; it ends when both do
function mergeStreams(
  first: ReadableStream<Uint8Array>,
  second: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const readers = [first.getReader(), second.getReader()];

  return new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const readInto = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
        for (;;) {
          const chunk = await reader.read();

          if (chunk.done) {
            return;
          }

          controller.enqueue(chunk.value);
        }
      };

      try {
        await Promise.all(readers.map((reader) => readInto(reader)));

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel: async () => {
      await Promise.all(readers.map((reader) => reader.cancel()));
    },
  });
}
