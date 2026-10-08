import { createServer } from 'node:net';
import type { Socket } from 'node:net';

// A TCP server on 127.0.0.1 that echoes what each connection sends and holds
// it open: the far end of a tunnel. Its release, deferred into `stack`,
// destroys every connection it holds and closes the server.
export async function startStubEchoServer(
  stack: Readonly<AsyncDisposableStack>,
): Promise<{ readonly port: number }> {
  const held = new Set<Socket>();

  const server = createServer((socket) => {
    held.add(socket);
    socket.on('error', () => {});
    socket.pipe(socket);
  });

  const listening = Promise.withResolvers<void>();

  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);

  await listening.promise;

  stack.defer(async () => {
    for (const socket of held) {
      socket.destroy();
    }

    const closed = Promise.withResolvers<void>();

    server.close(() => {
      closed.resolve();
    });

    await closed.promise;
  });

  const address = server.address();

  if (typeof address !== 'object' || address === null) {
    throw new Error('the echo server has no port');
  }

  return { port: address.port };
}
