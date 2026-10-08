import { expect, mock, test } from 'bun:test';
import { EXEC_CHANNELS, encodeExecFrame } from '@imp/api';
import { buildStubExecPeer } from './build-stub-exec-peer';
import type { StubExecHandler } from './build-stub-exec-peer';

test('it opens the socket after the client added its listeners and keeps the url', async () => {
  const peer = buildStubExecPeer();
  const socket = peer.connect('ws://impd.test/exec');
  const opened = Promise.withResolvers<number>();

  socket.addEventListener('open', () => {
    opened.resolve(socket.readyState);
  });

  expect(socket.readyState).toBe(WebSocket.CONNECTING);

  const state = await opened.promise;

  expect(state).toBe(WebSocket.OPEN);
  expect(peer.urls).toStrictEqual(['ws://impd.test/exec']);
});

test('it parses a control message the client sends and hands it to the peer', () => {
  const onMessage = mock<StubExecHandler>();
  const peer = buildStubExecPeer(onMessage);
  const socket = peer.connect('ws://impd.test/exec');

  socket.send(JSON.stringify({ type: 'stdin_eof' }));

  expect(peer.received).toStrictEqual([{ type: 'stdin_eof' }]);
  expect(onMessage).toHaveBeenCalledExactlyOnceWith(expect.any(Object), { type: 'stdin_eof' });
});

test('it records a stdin frame as its text and byte count', () => {
  const peer = buildStubExecPeer();
  const socket = peer.connect('ws://impd.test/exec');

  socket.send(encodeExecFrame(EXEC_CHANNELS.stdin, new TextEncoder().encode('typed')));

  expect(peer.received).toStrictEqual([{ type: 'stdin', text: 'typed', bytes: 5 }]);
});

test('it delivers a message, raw text and a frame on any channel to the client in order', async () => {
  const peer = buildStubExecPeer((link) => {
    link.send({ type: 'started', pid: 7 });
    link.sendText('{not json');
    link.sendFrame(9, 'x');
  });

  const socket = peer.connect('ws://impd.test/exec');
  const data: unknown[] = [];
  const three = Promise.withResolvers<void>();

  socket.addEventListener('message', (event) => {
    data.push(event.data);

    if (data.length === 3) {
      three.resolve();
    }
  });

  socket.send(JSON.stringify({ type: 'stdin_eof' }));

  await three.promise;

  expect(data).toStrictEqual([
    '{"type":"started","pid":7}',
    '{not json',
    new Uint8Array([9, 120]).buffer,
  ]);
});

test('it closes the client’s socket with the code and reason the peer gives', async () => {
  const peer = buildStubExecPeer((link) => {
    link.close(1011, 'agent gone');
  });

  const socket = peer.connect('ws://impd.test/exec');
  const closing = Promise.withResolvers<CloseEvent>();

  socket.addEventListener('close', (event) => {
    closing.resolve(event);
  });

  socket.send(JSON.stringify({ type: 'stdin_eof' }));

  const event = await closing.promise;

  expect(event.code).toBe(1011);
  expect(event.reason).toBe('agent gone');
  expect(socket.readyState).toBe(WebSocket.CLOSED);
});

test('it resolves closed once the client closes its socket', async () => {
  const peer = buildStubExecPeer();
  const socket = peer.connect('ws://impd.test/exec');

  socket.close();

  await expect(peer.closed).toResolve();
});
