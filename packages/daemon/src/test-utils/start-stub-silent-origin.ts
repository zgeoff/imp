interface SilentOriginOptions {
  // the control's path; `/control` by default
  readonly controlPath?: string;

  // what another path answers; the text "the long answer" by default
  readonly answer?: () => Response;
}

// A silent HTTP origin on loopback: the control waits until its client gives
// up, and any other path until then, so its answer outlasts the client's idle
// limit that the control's end proves expired.
export function startStubSilentOrigin(
  stack: AsyncDisposableStack,
  options: Readonly<SilentOriginOptions> = {},
) {
  const controlPath = options.controlPath ?? '/control';
  const answerLong = options.answer ?? (() => new Response('the long answer'));
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

      const isControl = new URL(request.url).pathname === controlPath;
      const gone = isControl ? controlGone : longGone;
      const held = isControl ? controlHeld : longHeld;

      held.resolve();

      request.signal.addEventListener('abort', () => {
        gone.resolve();
      });

      await controlGone.promise;

      return isControl ? new Response('too late') : answerLong();
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
