import { expect, onTestFinished, test } from 'bun:test';
import { connect } from 'node:net';
import { startStubPrivateService } from './start-stub-private-service';
import { waitFor } from './wait-for';

test('it greets a connection and counts it with the bytes it sent', async () => {
  const service = startStubPrivateService('127.0.0.1');

  onTestFinished(() => {
    service.stop();
  });

  const socket = connect(service.port, '127.0.0.1');

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
    if (service.readReceived() < 4) {
      throw new Error('not yet');
    }
  });

  expect(greeting).toBe('hello\n');
  expect(service.readAccepted()).toBe(1);
  expect(service.readReceived()).toBe(4);
});
