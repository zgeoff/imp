// A silent HTTP origin on loopback: `/control` waits until its client gives
// up, and any other path until then, so its "the long answer" outlasts the
// client's idle limit that the control's end proves expired.
export function startStubSilentOrigin(stack: AsyncDisposableStack) {
  const controlGone = Promise.withResolvers<void>();
  const longGone = Promise.withResolvers<void>();
  const controlHeld = Promise.withResolvers<void>();
  const longHeld = Promise.withResolvers<void>();

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',

    // the origin's own limit never ends a held answer
    idleTimeout: 0,
    fetch: async (request) => {
      await request.text();

      const isControl = new URL(request.url).pathname === '/control';
      const gone = isControl ? controlGone : longGone;
      const held = isControl ? controlHeld : longHeld;
      const answer = isControl ? 'too late' : 'the long answer';

      held.resolve();

      request.signal.addEventListener('abort', () => {
        gone.resolve();
      });

      await controlGone.promise;

      return new Response(answer);
    },
  });

  stack.defer(() => server.stop(true));

  return {
    origin: `http://127.0.0.1:${String(server.port)}`,

    // the origin holds the control's answer, or another path's
    controlHeld: controlHeld.promise,
    longHeld: longHeld.promise,

    // the control's client gave up
    controlGone: controlGone.promise,

    // a client of another path gave up
    longGone: longGone.promise,
  };
}
