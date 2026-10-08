// A rule's plain-HTTP upstream on a free loopback port: a real listener, for
// a test of what goes on the wire, such as the Host header, which
// interception never sees. Its stop goes into the caller's stack.
export function startStubBrokerPlainUpstream(
  stack: Readonly<AsyncDisposableStack>,
  fetch: (request: Request) => Response | Promise<Response>,
) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch });

  stack.defer(() => server.stop(true));

  const port = server.port ?? 0;

  return { port, origin: `http://127.0.0.1:${String(port)}` };
}
