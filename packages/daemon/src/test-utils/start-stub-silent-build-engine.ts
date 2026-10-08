import { onTestFinished } from 'bun:test';
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

// Docker's engine answering a build at once, then silent until `holdUntil`
// settles, as through a RUN step with no output; a raw socket server, so no
// Bun server idle limit ends the silence. It stops when the test ends.
export async function startStubSilentBuildEngine(options: StubSilentBuildEngineOptions) {
  const sockets = new Set<Socket>();

  const firstClose = Promise.withResolvers<void>();
  const firstRequest = Promise.withResolvers<void>();

  const engine = createServer((socket) => {
    sockets.add(socket);

    socket.on('close', () => {
      sockets.delete(socket);
      firstClose.resolve();
    });

    socket.on('error', () => {});

    socket.once('data', () => {
      firstRequest.resolve();
      void sendBuildAnswer(socket, options);
    });
  });

  await new Promise<void>((resolve) => {
    engine.listen(options.socketPath, resolve);
  });

  // the first stop closes the engine; a later one waits on the same close
  const stopping: { done: Promise<void> | null } = { done: null };

  const stop = (): Promise<void> => {
    stopping.done ??= new Promise<void>((resolve) => {
      for (const socket of sockets) {
        socket.destroy();
      }

      engine.close(() => {
        resolve();
      });
    });

    return stopping.done;
  };

  onTestFinished(stop);

  return {
    // settles once the first connection closes, from either end
    closed: firstClose.promise,

    // settles once the first request has arrived and been answered at once
    started: firstRequest.promise,
    stop,
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
