import { createConnection } from 'node:net';

interface StubGuestSocketOptions {
  readonly port: number;

  // the guest's own address: a loopback one stands for a slot's guest
  readonly address: string;
}

// A guest's raw connection to the broker's front port on 127.0.0.1, open
// until the caller's stack releases it. `reply` resolves with every byte the
// broker sent once the connection closes.
export async function startStubBrokerGuestSocket(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<StubGuestSocketOptions>,
) {
  const connected = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<string>();
  const chunks: Buffer[] = [];

  const socket = createConnection(
    { host: '127.0.0.1', port: options.port, localAddress: options.address },
    () => {
      connected.resolve();
    },
  );

  stack.defer(() => {
    socket.destroy();
  });

  socket.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  socket.on('error', (error) => {
    connected.reject(error);
  });

  socket.once('close', () => {
    reply.resolve(Buffer.concat(chunks).toString());
  });

  await connected.promise;

  return {
    reply: reply.promise,
    write: (text: string): void => {
      socket.write(text);
    },
  };
}
