interface ProxySocketData {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly pending: (string | ArrayBuffer)[];
  upstream: WebSocket | null;
}

interface StubPrefixProxyOptions {
  // where the proxy sends what it takes, such as impd's loopback URL
  readonly target: string;

  // the path the proxy serves the target under, such as `/imp`
  readonly prefix: string;
}

// close codes a peer may send; the rest only report what happened
function isSendableCloseCode(code: number): boolean {
  return code === 1000 || (code >= 3000 && code <= 4999) || (code >= 1001 && code <= 1014);
}

// A loopback reverse proxy that serves `target` under `prefix`, as one in
// front of impd does: 404 outside the prefix, and `paths` records each path
// it was asked for. Its stop goes into `stack`.
export function startStubPrefixProxy(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<StubPrefixProxyOptions>,
) {
  const paths: string[] = [];

  const server = Bun.serve<ProxySocketData>({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, bunServer) => {
      const url = new URL(request.url);

      paths.push(url.pathname);

      if (!url.pathname.startsWith(`${options.prefix}/`)) {
        return new Response('not found', { status: 404 });
      }

      const forwarded = new URL(
        `${url.pathname.slice(options.prefix.length)}${url.search}`,
        options.target,
      );

      const headers = new Headers(request.headers);

      headers.delete('host');

      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const authorization = request.headers.get('authorization');

        forwarded.protocol = forwarded.protocol === 'https:' ? 'wss:' : 'ws:';

        const data: ProxySocketData = {
          url: forwarded.href,
          headers: authorization === null ? {} : { authorization },
          pending: [],
          upstream: null,
        };

        return bunServer.upgrade(request, { data })
          ? undefined
          : new Response('no upgrade', { status: 400 });
      }

      return fetch(forwarded, {
        method: request.method,
        headers,
        body: request.body,
      });
    },
    websocket: {
      open: (ws) => {
        const upstream = new WebSocket(ws.data.url, { headers: { ...ws.data.headers } });

        upstream.binaryType = 'arraybuffer';
        ws.data.upstream = upstream;

        upstream.addEventListener('open', () => {
          for (const data of ws.data.pending.splice(0)) {
            upstream.send(data);
          }
        });

        upstream.addEventListener('message', (event) => {
          const data =
            event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : String(event.data);

          ws.send(data);
        });

        upstream.addEventListener('close', (event) => {
          if (isSendableCloseCode(event.code)) {
            ws.close(event.code, event.reason);
          } else {
            ws.close();
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
        ws.data.upstream?.close();
      },
    },
  });

  stack.defer(async () => {
    await server.stop(true);
  });

  return { url: `http://127.0.0.1:${String(server.port)}${options.prefix}`, paths };
}
