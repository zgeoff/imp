import { expect, mock, onTestFinished, test } from 'bun:test';
import { TUNNEL_CLOSE_LOST, TUNNEL_CLOSE_PROTOCOL } from '@imp/api';
import { waitFor } from '@imp/test-utils/wait-for';
import { startStubTunnel } from './start-stub-tunnel';
import type { StubTunnelPeer, StubTunnelReceived } from './start-stub-tunnel';

test('it refuses a socket whose bearer is not the token with 401', async () => {
  await using tunnel = startStubTunnel({ token: 'secret', onMessage: () => {} });

  const response = await fetch(`${tunnel.url}/tunnel`, {
    headers: { authorization: 'Bearer other' },
  });

  expect(response.status).toBe(401);
});

test('it hands each control message to the script as impd parses it', async () => {
  const onMessage = mock<(peer: StubTunnelPeer, message: StubTunnelReceived) => void>();

  await using tunnel = startStubTunnel({ token: 'secret', onMessage });

  const ws = new WebSocket(`${tunnel.url.replace('http', 'ws')}/tunnel`, {
    headers: { authorization: 'Bearer secret' },
  });

  onTestFinished(() => {
    ws.close();
  });

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'open', name: 'box', port: 80, extra: true }));
  });

  await waitFor(() => {
    expect(onMessage).toHaveBeenCalledOnce();
  });

  expect(tunnel.received).toStrictEqual([{ type: 'open', name: 'box', port: 80 }]);
  expect(onMessage).toHaveBeenCalledWith(tunnel.peers[0], { type: 'open', name: 'box', port: 80 });
});

test('it records a binary message as its bytes', async () => {
  await using tunnel = startStubTunnel({ token: 'secret', onMessage: () => {} });

  const ws = new WebSocket(`${tunnel.url.replace('http', 'ws')}/tunnel`, {
    headers: { authorization: 'Bearer secret' },
  });

  onTestFinished(() => {
    ws.close();
  });

  ws.addEventListener('open', () => {
    ws.send(new TextEncoder().encode('hello'));
  });

  await waitFor(() => {
    expect(tunnel.received).toHaveLength(1);
  });

  expect(tunnel.received).toStrictEqual([
    { type: 'data', data: new TextEncoder().encode('hello') },
  ]);
});

test('it closes with the protocol code on text that is not a client message', async () => {
  await using tunnel = startStubTunnel({ token: 'secret', onMessage: () => {} });

  const closed = Promise.withResolvers<number>();

  const ws = new WebSocket(`${tunnel.url.replace('http', 'ws')}/tunnel`, {
    headers: { authorization: 'Bearer secret' },
  });

  ws.addEventListener('open', () => {
    ws.send('not json');
  });

  ws.addEventListener('close', (event) => {
    closed.resolve(event.code);
  });

  const code = await closed.promise;

  expect(code).toBe(TUNNEL_CLOSE_PROTOCOL);
  expect(tunnel.received).toBeEmpty();
});

test('it sends the script’s messages, text, bytes and close to the client', async () => {
  await using tunnel = startStubTunnel({
    token: 'secret',
    onMessage: (peer) => {
      peer.send({ type: 'opened' });
      peer.sendText('not json');
      peer.sendBinary(new TextEncoder().encode('bytes'));
      peer.close(TUNNEL_CLOSE_LOST, 'lost');
    },
  });

  const messages: unknown[] = [];
  const closed = Promise.withResolvers<number>();

  const ws = new WebSocket(`${tunnel.url.replace('http', 'ws')}/tunnel`, {
    headers: { authorization: 'Bearer secret' },
  });

  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'eof' }));
  });

  ws.addEventListener('message', (event) => {
    const data: unknown =
      event.data instanceof ArrayBuffer ? new TextDecoder().decode(event.data) : event.data;

    messages.push(data);
  });

  ws.addEventListener('close', (event) => {
    closed.resolve(event.code);
  });

  const code = await closed.promise;

  expect(code).toBe(TUNNEL_CLOSE_LOST);
  expect(messages).toStrictEqual(['{"type":"opened"}', 'not json', 'bytes']);
});

test('it answers a request off the tunnel from the fallback', async () => {
  await using tunnel = startStubTunnel({
    token: 'secret',
    onMessage: () => {},
    fallback: (request) => Response.json({ path: new URL(request.url).pathname }),
  });

  const response = await fetch(`${tunnel.url}/rpc/imps/get`, { method: 'POST' });
  const body: unknown = await response.json();

  expect(body).toStrictEqual({ path: '/rpc/imps/get' });
});

test('it answers a request off the tunnel with 404 without a fallback', async () => {
  await using tunnel = startStubTunnel({ token: 'secret', onMessage: () => {} });

  const response = await fetch(`${tunnel.url}/rpc/imps/get`, { method: 'POST' });

  expect(response.status).toBe(404);
});

test('it numbers the peers in the order the sockets opened', async () => {
  await using tunnel = startStubTunnel({ token: 'secret', onMessage: () => {} });

  const sockets = [0, 1].map(
    () =>
      new WebSocket(`${tunnel.url.replace('http', 'ws')}/tunnel`, {
        headers: { authorization: 'Bearer secret' },
      }),
  );

  onTestFinished(() => {
    for (const ws of sockets) {
      ws.close();
    }
  });

  await waitFor(() => {
    expect(tunnel.peers).toHaveLength(2);
  });

  expect(tunnel.peers.map((peer) => peer.index)).toStrictEqual([0, 1]);
});
