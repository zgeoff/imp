// impd on loopback for a CLI child, its system.info connection dropping
// before any answer; every other call reaches the app behind `fetch`. It
// records each call's procedure, and its stop goes into `stack`.
export function startStubInfoFaultImpd(
  stack: Readonly<AsyncDisposableStack>,
  fetch: (request: Request) => Promise<Response>,
) {
  const calls: string[] = [];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;

      calls.push(path.slice(path.indexOf('/rpc/') + '/rpc/'.length));

      if (path.endsWith('/rpc/system/info')) {
        // a body that fails before its first byte resets the connection
        return new Response(
          new ReadableStream({
            start: (controller) => {
              controller.error(new Error('the connection dropped'));
            },
          }),
        );
      }

      return fetch(request);
    },
  });

  stack.defer(async () => {
    await server.stop(true);
  });

  return { url: `http://127.0.0.1:${String(server.port)}`, calls };
}
