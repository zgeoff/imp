// A loopback host that takes each request and never answers, as a stalled
// host does: a network fault, not an impd. Its stop goes into `stack` and
// closes every held connection.
export function startStubSilentHost(stack: Readonly<AsyncDisposableStack>) {
  const requests: string[] = [];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,

    // a stall outlasts any client deadline under test
    idleTimeout: 0,
    fetch: (request) => {
      requests.push(new URL(request.url).pathname);

      return new Promise<Response>(() => {
        // never answers
      });
    },
  });

  stack.defer(async () => {
    await server.stop(true);
  });

  // the path of each request it took
  return { url: `http://127.0.0.1:${String(server.port)}`, requests };
}
