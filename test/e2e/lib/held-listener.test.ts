import { expect, onTestFinished, test } from 'bun:test';
import { connect } from 'node:net';
import { startHeldListener } from './held-listener';
import { waitFor } from './wait-for';

test('it greets a connection and counts it with the bytes it sent', async () => {
  const listener = startHeldListener('127.0.0.1');

  onTestFinished(() => {
    listener.stop();
  });

  const socket = connect(listener.port, '127.0.0.1');

  onTestFinished(() => {
    socket.destroy();
  });

  const greeting = await new Promise<string>((resolve) => {
    socket.once('data', (chunk) => {
      resolve(chunk.toString());
    });
  });

  socket.write('abcd');

  await waitFor('the bytes to arrive', () => {
    if (listener.readReceived() < 4) {
      throw new Error('not yet');
    }
  });

  expect(greeting).toBe('hello\n');
  expect(listener.readAccepted()).toBe(1);
  expect(listener.readReceived()).toBe(4);
});
