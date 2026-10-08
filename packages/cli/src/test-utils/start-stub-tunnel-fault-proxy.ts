interface FaultSocketData {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly pending: (string | ArrayBuffer)[];
  readonly tunnel: FaultTunnel;
  upstream: WebSocket | null;
}

interface FaultTunnel {
  // impd's text messages to the client, in order, such as `{"type":"opened"}`
  readonly toClient: string[];
  isClosed: boolean;
}

// close codes a peer may send in a close frame; 1005 and 1006 only report
// that none came, so the client's connection drops without one
function isSendableCloseCode(code: number): boolean {
  return (
    (code >= 1000 && code <= 1003) ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
  );
}

// A loopback proxy that relays HTTP and WebSockets to real impd, and can put
// a text impd never sends into one WebSocket towards the client: a fault on
// the path. Its stop goes into `stack`.
export function startStubTunnelFaultProxy(stack: Readonly<AsyncDisposableStack>, target: string) {
  const tunnels: FaultTunnel[] = [];
  const clients: Bun.ServerWebSocket<FaultSocketData>[] = [];

  const server = Bun.serve<FaultSocketData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, bunServer) => {
      const url = new URL(request.url);
      const forwarded = new URL(`${url.pathname}${url.search}`, target);

      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        const headers = new Headers(request.headers);

        headers.delete('host');

        return fetch(forwarded, { method: request.method, headers, body: request.body });
      }

      const authorization = request.headers.get('authorization');

      forwarded.protocol = 'ws:';

      const data: FaultSocketData = {
        url: forwarded.href,
        headers: authorization === null ? {} : { authorization },
        pending: [],
        tunnel: { toClient: [], isClosed: false },
        upstream: null,
      };

      return bunServer.upgrade(request, { data })
        ? undefined
        : new Response('no upgrade', { status: 400 });
    },
    websocket: {
      open: (ws) => {
        const upstream = new WebSocket(ws.data.url, { headers: { ...ws.data.headers } });

        tunnels.push(ws.data.tunnel);
        clients.push(ws);

        upstream.binaryType = 'arraybuffer';
        ws.data.upstream = upstream;

        upstream.addEventListener('open', () => {
          for (const data of ws.data.pending.splice(0)) {
            upstream.send(data);
          }
        });

        upstream.addEventListener('message', (event) => {
          if (event.data instanceof ArrayBuffer) {
            ws.send(new Uint8Array(event.data));

            return;
          }

          ws.data.tunnel.toClient.push(String(event.data));
          ws.send(String(event.data));
        });

        upstream.addEventListener('close', (event) => {
          if (isSendableCloseCode(event.code)) {
            ws.close(event.code, event.reason);
          } else {
            ws.terminate();
          }
        });
      },
      message: (ws, data) => {
        const message = typeof data === 'string' ? data : new Uint8Array(data).slice().buffer;
        const upstream = ws.data.upstream;

        if (upstream?.readyState === WebSocket.OPEN) {
          upstream.send(message);
        } else {
          ws.data.pending.push(message);
        }
      },
      close: (ws) => {
        ws.data.tunnel.isClosed = true;
        ws.data.upstream?.close();
      },
    },
  });

  stack.defer(async () => {
    await server.stop(true);
  });

  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    tunnels,

    // sends `text` to the client on the WebSocket that opened `index`th
    sendText: (index: number, text: string): void => {
      const client = clients[index];

      if (client === undefined) {
        throw new Error(`no WebSocket ${String(index)} has opened`);
      }

      client.send(text);
    },
  };
}
