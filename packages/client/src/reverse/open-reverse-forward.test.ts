import { afterEach, expect, test } from 'bun:test';
import { TUNNEL_CLOSE_LOST, TunnelClientMessageSchema } from '@imp/api';
import type { TunnelServerMessage } from '@imp/api';
import type { ServerWebSocket } from 'bun';
import { openReverseForward } from './open-reverse-forward';
import type { ReverseForward } from './open-reverse-forward';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const decoder = new TextDecoder();

function sendServer(ws: ServerWebSocket, message: TunnelServerMessage): void {
  ws.send(JSON.stringify(message));
}

// An impd that serves only `/tunnel`: a listen answers `listening`, and an
// accept relays to a guest client that answers `got <bytes>` and closes.
function startFakeImpd() {
  const controls: ServerWebSocket[] = [];
  const received: unknown[] = [];

  const server = Bun.serve({
    port: 0,
    fetch: (request, bunServer) =>
      bunServer.upgrade(request) ? undefined : new Response('', { status: 400 }),
    websocket: {
      message: (ws, message) => {
        if (typeof message !== 'string') {
          sendServer(ws, { type: 'ack', bytes: message.byteLength });

          ws.send(new TextEncoder().encode(`got ${decoder.decode(message)}`));

          sendServer(ws, { type: 'eof' });

          return;
        }

        const control = TunnelClientMessageSchema.parse(JSON.parse(message));

        received.push(control);

        if (control.type === 'listen') {
          controls.push(ws);

          sendServer(ws, {
            type: 'listening',
            listener: 'fwd1',
            path: '/tmp/app.sock',
            port: null,
          });
        } else if (control.type === 'accept') {
          sendServer(ws, { type: 'opened' });
        } else if (control.type === 'eof') {
          ws.close(1000, 'done');
        }
      },
    },
  });

  cleanups.push(() => {
    void server.stop(true);
  });

  return { url: `http://127.0.0.1:${String(server.port)}`, controls, received };
}

function openForward(url: string, onReply: (reply: string) => void): ReverseForward {
  const forward = openReverseForward({
    baseUrl: url,
    token: 'secret',
    name: 'box',
    guest: { network: 'unix', path: '/tmp/app.sock' },
    connect: (socketUrl, headers) => new WebSocket(socketUrl, { headers: { ...headers } }),
    onConnection: (accept) => {
      const relay = accept({
        onData: (data) => {
          onReply(decoder.decode(data));
        },
        onEof: () => {
          relay.sendEof();
        },
        onClose: () => {},
      });

      relay.send(new TextEncoder().encode('hello'));
    },
  });

  cleanups.push(forward.stop);

  return forward;
}

test('a forward listens, and a client in the imp is accepted and relayed', async () => {
  const impd = startFakeImpd();
  const replies: string[] = [];

  const forward = openForward(impd.url, (reply) => {
    replies.push(reply);
  });

  const listening = await forward.listening;

  const [control] = impd.controls;

  if (control === undefined) {
    throw new Error('no control socket');
  }

  sendServer(control, { type: 'connection', id: 3 });

  while (replies.length === 0) {
    await Bun.sleep(5);
  }

  expect(listening).toEqual({ path: '/tmp/app.sock', port: null });
  expect(replies).toEqual(['got hello']);

  expect(impd.received).toContainEqual({
    type: 'accept',
    name: 'box',
    listener: 'fwd1',
    connection: 3,
  });
});

test('a listener that ends in the imp ends the forward as lost', async () => {
  const impd = startFakeImpd();
  const forward = openForward(impd.url, () => {});

  await forward.listening;

  impd.controls[0]?.close(TUNNEL_CLOSE_LOST, 'lost');

  const end = await forward.ended;

  expect(end).toEqual({ kind: 'lost' });
});
