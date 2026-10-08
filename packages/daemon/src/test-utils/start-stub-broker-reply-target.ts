import { createServer } from 'node:net';
import type { Socket } from 'node:net';

// The far end of a plain tunnel on a free loopback port: raw TCP, which the
// broker relays byte for byte. It reads each request head, records it in
// `received`, then answers a 200 whose body is `body` and closes.
export async function startStubBrokerReplyTarget(
  stack: Readonly<AsyncDisposableStack>,
  body: string,
) {
  const sockets = new Set<Socket>();

  const received: string[] = [];

  const server = createServer((socket) => {
    const chunks: Buffer[] = [];

    sockets.add(socket);
    socket.on('error', () => {});

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);

      const head = Buffer.concat(chunks).toString('latin1');

      if (head.includes('\r\n\r\n')) {
        received.push(head);

        socket.end(
          `HTTP/1.1 200 OK\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\nconnection: close\r\n\r\n${body}`,
        );
      }
    });
  });

  const listening = Promise.withResolvers<void>();

  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);

  await listening.promise;

  stack.defer(async () => {
    for (const socket of sockets) {
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
    throw new Error('the reply target has no port');
  }

  return { port: address.port, received };
}
