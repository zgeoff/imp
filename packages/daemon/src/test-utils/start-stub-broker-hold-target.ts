import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

// closes the listener and ends its connections; safe again once stopped
async function stopServer(server: Server, sockets: ReadonlySet<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }

  if (!server.listening) {
    return;
  }

  const closed = Promise.withResolvers<void>();

  server.close(() => {
    closed.resolve();
  });

  await closed.promise;
}

// The far end of a plain tunnel on a free loopback port that holds every
// connection open, saying nothing, until it stops
export async function startStubBrokerHoldTarget(stack: Readonly<AsyncDisposableStack>) {
  const held = new Set<Socket>();

  const server = createServer((socket) => {
    held.add(socket);
    socket.on('error', () => {});
  });

  const listening = Promise.withResolvers<void>();

  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);

  await listening.promise;

  stack.defer(() => stopServer(server, held));

  const address = server.address();

  if (typeof address !== 'object' || address === null) {
    throw new Error('the hold target has no port');
  }

  return {
    port: address.port,
    held,

    // ends the held connections at once; the stack then finds it stopped
    stop: () => stopServer(server, held),
  };
}
