// What the echo saw of one request: the path and Host it got, and the
// headers a proxy in front of it adds, keeps or strips.
interface HeaderEcho {
  readonly path: string;
  readonly proto: string | null;

  // the dashboard's same-origin check compares the Origin with this
  readonly host: string;
  readonly cookie: string | null;
  readonly authorization: string | null;
  readonly forwardedFor: string | null;
  readonly forwarded: string | null;
  readonly realIp: string | null;
  readonly forwardedHost: string | null;
}

// An imp or impd's API behind a proxy: it answers each request with a
// HeaderEcho as JSON and sends each WebSocket message back. Its release,
// deferred into `stack`, closes every connection it holds.
export function startStubHeaderEcho(stack: Readonly<AsyncDisposableStack>): {
  readonly port: number;
} {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, upgrader) => {
      if (request.headers.get('upgrade') === 'websocket') {
        return upgrader.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 });
      }

      const url = new URL(request.url);

      const echo: HeaderEcho = {
        path: url.pathname,
        proto: request.headers.get('x-forwarded-proto'),
        host: url.host,
        cookie: request.headers.get('cookie'),
        authorization: request.headers.get('authorization'),
        forwardedFor: request.headers.get('x-forwarded-for'),
        forwarded: request.headers.get('forwarded'),
        realIp: request.headers.get('x-real-ip'),
        forwardedHost: request.headers.get('x-forwarded-host'),
      };

      return Response.json(echo);
    },
    websocket: {
      message: (ws, message) => {
        ws.send(message);
      },
    },
  });

  stack.defer(() => server.stop(true));

  if (server.port === undefined) {
    throw new Error('the header echo has no port');
  }

  return { port: server.port };
}
