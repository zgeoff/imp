import { createServer } from 'node:net';
import type { Socket } from 'node:net';

interface StubSilentBuildEngineOptions {
  // the unix socket the engine listens on
  readonly socketPath: string;

  // the image the build ends with
  readonly imageId: string;

  // called on each build; the engine stays silent until it settles
  readonly holdUntil: () => Promise<void>;
}

export interface StubSilentBuildEngine {
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

// Docker's engine answering a build at once, then sending nothing until
// `holdUntil` settles, as BuildKit does through a RUN step with no output.
// A raw socket server, so no idle limit of a Bun server ends the silence.
export async function startStubSilentBuildEngine(
  options: StubSilentBuildEngineOptions,
): Promise<StubSilentBuildEngine> {
  const sockets = new Set<Socket>();

  const engine = createServer((socket) => {
    sockets.add(socket);

    socket.on('close', () => {
      sockets.delete(socket);
    });

    socket.on('error', () => {});

    socket.once('data', () => {
      void sendBuildAnswer(socket, options);
    });
  });

  await new Promise<void>((resolve) => {
    engine.listen(options.socketPath, resolve);
  });

  // the first dispose closes the engine; a later one waits on the same close
  const closing: { done: Promise<void> | null } = { done: null };

  return {
    [Symbol.asyncDispose]: () => {
      closing.done ??= new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }

        engine.close(() => {
          resolve();
        });
      });

      return closing.done;
    },
  };
}

// the build's answer: a trace at once, the image id when the hold settles
async function sendBuildAnswer(
  socket: Socket,
  options: StubSilentBuildEngineOptions,
): Promise<void> {
  socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n');
  socket.write('Transfer-Encoding: chunked\r\n\r\n');
  socket.write(toChunk({ id: 'moby.buildkit.trace', aux: 'CgQ=' }));

  await options.holdUntil();

  socket.end(`${toChunk({ id: 'moby.image.id', aux: { ID: options.imageId } })}0\r\n\r\n`);
}

// one line of the engine's JSON stream, as an HTTP chunk
function toChunk(line: unknown): string {
  const text = `${JSON.stringify(line)}\n`;

  return `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`;
}
