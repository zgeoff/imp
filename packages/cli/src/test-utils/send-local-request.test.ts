import { expect, onTestFinished, test } from 'bun:test';
import { createServer } from 'node:net';
import { findFreePorts } from '@imp/daemon/src/test-utils/find-free-ports';
import { sendLocalRequest } from './send-local-request';

test('it sends the body, half-closes, and resolves with the whole reply', async () => {
  const port = findFreePorts(1).take();

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const chunks: Buffer[] = [];

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    socket.on('end', () => {
      socket.end(`got ${Buffer.concat(chunks).toString()}`);
    });
  });

  onTestFinished(() => {
    server.close();
  });

  const listening = Promise.withResolvers<void>();

  server.listen(port, '127.0.0.1', listening.resolve);

  await listening.promise;

  const reply = await sendLocalRequest('127.0.0.1', port, new TextEncoder().encode('ping'));

  expect(reply).toBe('got ping');
});

test('it rejects when the far end resets the connection', async () => {
  const port = findFreePorts(1).take();

  const server = createServer((socket) => {
    socket.resetAndDestroy();
  });

  onTestFinished(() => {
    server.close();
  });

  const listening = Promise.withResolvers<void>();

  server.listen(port, '127.0.0.1', listening.resolve);

  await listening.promise;

  expect(sendLocalRequest('127.0.0.1', port, new Uint8Array(1))).rejects.toMatchObject({
    code: 'ECONNRESET',
  });
});
