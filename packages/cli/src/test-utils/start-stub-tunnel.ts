import { TUNNEL_CLOSE_PROTOCOL, TUNNEL_PATH, TunnelClientMessageSchema } from '@imp/api';
import type { TunnelClientMessage, TunnelServerMessage } from '@imp/api';

// what a client sent on one socket: a control message as impd parses it, or
// a binary message's bytes
export type StubTunnelReceived =
  | TunnelClientMessage
  | { readonly type: 'data'; readonly data: Uint8Array };

// impd's side of one tunnel socket, which the test scripts
export interface StubTunnelPeer {
  // the socket's place in the order the sockets opened
  readonly index: number;
  readonly send: (message: TunnelServerMessage) => void;

  // any text, so a test can send one that breaks the protocol
  readonly sendText: (text: string) => void;
  readonly sendBinary: (data: Uint8Array) => void;
  readonly close: (code: number, reason: string) => void;
}

interface StubTunnelOptions {
  // the bearer a socket must carry; any other gets 401, as from impd
  readonly token: string;

  // called with each message a client sends, after it is recorded
  readonly onMessage: (peer: StubTunnelPeer, message: StubTunnelReceived) => void;

  // answers every request that is not the tunnel, such as impd's own app
  // for /rpc; 404 when left out
  readonly fallback?: (request: Request) => Response | Promise<Response>;
}

interface SocketData {
  readonly index: number;
}

// impd's `/tunnel` WebSocket on a loopback port, for faults a real impd
// never sends: text that is not JSON, held acks, a lost listener.

// Text that is no client message closes the socket with TUNNEL_CLOSE_PROTOCOL,
// as impd does; `received` holds every socket's messages in arrival order.
export function startStubTunnel(options: StubTunnelOptions) {
  const received: StubTunnelReceived[] = [];
  const peers: StubTunnelPeer[] = [];

  const server = Bun.serve<SocketData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, bunServer) => {
      if (new URL(request.url).pathname !== TUNNEL_PATH) {
        return options.fallback?.(request) ?? new Response('not found', { status: 404 });
      }

      if (request.headers.get('authorization') !== `Bearer ${options.token}`) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }

      const upgraded = bunServer.upgrade(request, { data: { index: peers.length } });

      return upgraded ? undefined : new Response('no upgrade', { status: 400 });
    },
    websocket: {
      open: (ws) => {
        peers[ws.data.index] = {
          index: ws.data.index,
          send: (message) => {
            ws.send(JSON.stringify(message));
          },
          sendText: (text) => {
            ws.send(text);
          },
          sendBinary: (data) => {
            ws.sendBinary(data);
          },
          close: (code, reason) => {
            ws.close(code, reason);
          },
        };
      },
      message: (ws, message) => {
        const peer = peers[ws.data.index];

        if (peer === undefined) {
          return;
        }

        if (typeof message !== 'string') {
          const data = { type: 'data', data: new Uint8Array(message) } as const;

          received.push(data);
          options.onMessage(peer, data);

          return;
        }

        const parsed = TunnelClientMessageSchema.safeParse(parseJson(message));

        if (!parsed.success) {
          ws.close(TUNNEL_CLOSE_PROTOCOL, 'bad message');

          return;
        }

        received.push(parsed.data);
        options.onMessage(peer, parsed.data);
      },
    },
  });

  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    received,
    peers,
    [Symbol.asyncDispose]: () => server.stop(true),
  };
}

// null for text that is not JSON, which the schema then refuses
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
