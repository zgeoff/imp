interface SilentOriginOptions {
  // the control's path; `/control` by default
  readonly controlPath?: string;

  // what another path answers; the text "the long answer" by default
  readonly answer?: () => Response;

  // the answer to a request it does not hold, or null to hold it; null for
  // every request by default
  readonly answerAtOnce?: (request: Request) => Response | null;

  // a unix socket to listen on, as Docker's engine does; loopback TCP when
  // left out
  readonly unix?: string;
}

// A silent HTTP origin: the control waits until its client gives up, and any
// other path until then, so its answer outlasts the client's idle limit that
// the control's end proves expired.
export function startStubSilentOrigin(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<SilentOriginOptions> = {},
) {
  const controlPath = options.controlPath ?? '/control';
  const answerLong = options.answer ?? (() => new Response('the long answer'));
  const answerAtOnce = options.answerAtOnce ?? (() => null);
  const controlGone = Promise.withResolvers<void>();
  const longGone = Promise.withResolvers<void>();
  const controlHeld = Promise.withResolvers<void>();
  const longHeld = Promise.withResolvers<void>();

  const sendAnswer = async (request: Request): Promise<Response> => {
    await request.text();

    const isControl = new URL(request.url).pathname === controlPath;
    const atOnce = isControl ? null : answerAtOnce(request);

    if (atOnce !== null) {
      return atOnce;
    }

    const gone = isControl ? controlGone : longGone;
    const held = isControl ? controlHeld : longHeld;

    held.resolve();

    request.signal.addEventListener('abort', () => {
      gone.resolve();
    });

    await controlGone.promise;

    return isControl ? new Response('too late') : answerLong();
  };

  // the origin's own limit never ends a held answer; Bun's types leave
  // idleTimeout off unix servers, but it applies there too
  const listen =
    options.unix === undefined ? { port: 0, hostname: '127.0.0.1' } : { unix: options.unix };

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  const server = Bun.serve({
    ...listen,
    idleTimeout: 0,
    fetch: sendAnswer,
  } as unknown as Bun.Serve.Options<undefined>);

  stack.defer(() => server.stop(true));

  return {
    origin:
      options.unix === undefined ? `http://127.0.0.1:${String(server.port)}` : 'http://docker',

    // the origin holds the control's answer, or another path's
    controlHeld: controlHeld.promise,
    longHeld: longHeld.promise,

    // the control's client gave up
    controlGone: controlGone.promise,

    // a client of another path gave up
    longGone: longGone.promise,
  };
}
