import { expect, test } from 'bun:test';
import { EXEC_CHANNELS, encodeExecFrame } from '@imp/api';
import { buildStubExecSocket } from './build-stub-exec-socket';

test('it records a text message parsed as JSON', () => {
  const socket = buildStubExecSocket();

  socket.peer.sendText(JSON.stringify({ type: 'started', pid: 7 }));

  expect(socket.sent).toStrictEqual([{ type: 'started', pid: 7 }]);
});

test('it records a binary frame as its channel and text', () => {
  const socket = buildStubExecSocket();

  const kept = socket.peer.sendBinary(
    encodeExecFrame(EXEC_CHANNELS.stdout, new TextEncoder().encode('out')),
  );

  expect(kept).toBe(true);
  expect(socket.sent).toStrictEqual([[EXEC_CHANNELS.stdout, 'out']]);
});

test('it drops the binary messages past the ones it keeps', () => {
  const socket = buildStubExecSocket({ keeps: 1 });

  socket.peer.sendBinary(encodeExecFrame(EXEC_CHANNELS.stdout, new TextEncoder().encode('one')));

  const kept = socket.peer.sendBinary(
    encodeExecFrame(EXEC_CHANNELS.stdout, new TextEncoder().encode('two')),
  );

  expect(kept).toBe(false);
  expect(socket.sent).toStrictEqual([[EXEC_CHANNELS.stdout, 'one']]);
});

test('it records a close without a code as 1000', () => {
  const socket = buildStubExecSocket();

  socket.peer.close();
  socket.peer.close(1011, 'exec failed');

  expect(socket.closes).toStrictEqual([1000, 1011]);
});

test('it reports nothing queued for the client', () => {
  expect(buildStubExecSocket().peer.readBufferedAmount()).toBe(0);
});
