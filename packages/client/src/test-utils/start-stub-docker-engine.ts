import { onTestFinished } from 'bun:test';

interface StubDockerEngineOptions {
  // the unix socket the engine listens on
  readonly socketPath: string;

  // the image every build ends with
  readonly imageId: string;

  // each build answers its first line at once, then waits for this
  readonly holdUntil?: () => Promise<void>;

  // the error a build ends with, in place of the image
  readonly failure?: string;
}

// Docker's engine API for impd's host build: POST /build answers a trace
// line, then the image ID or the error; any other call gets a 500 naming it
// and lands in `unexpected`. It stops at the test's end.
export function startStubDockerEngine(options: StubDockerEngineOptions) {
  const contexts: Uint8Array[] = [];
  const signals: AbortSignal[] = [];
  const unexpected: string[] = [];

  // a held build stays open however long it is silent, as docker keeps it;
  // Bun's types leave idleTimeout off unix servers, but it applies there too
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  const server = Bun.serve({
    unix: options.socketPath,
    idleTimeout: 0,
    fetch: async (request: Request) => {
      const call = `${request.method} ${new URL(request.url).pathname}`;

      if (call !== 'POST /build') {
        unexpected.push(call);

        return Response.json(
          { message: `stub docker engine: ${call} is not modelled` },
          { status: 500 },
        );
      }

      signals.push(request.signal);

      const context = await request.bytes();

      contexts.push(context);

      const answer = new ReadableStream<string>({
        start: async (controller) => {
          controller.enqueue(`${JSON.stringify({ id: 'moby.buildkit.trace', aux: 'CgQ=' })}\n`);

          await options.holdUntil?.();

          const last =
            options.failure === undefined
              ? { id: 'moby.image.id', aux: { ID: options.imageId } }
              : { errorDetail: { message: options.failure }, error: options.failure };

          controller.enqueue(`${JSON.stringify(last)}\n`);
          controller.close();
        },
      });

      return new Response(answer.pipeThrough(new TextEncoderStream()), {
        headers: { 'content-type': 'application/json' },
      });
    },
  } as unknown as Bun.Serve.Options<undefined>);

  onTestFinished(() => server.stop(true));

  return { contexts, signals, unexpected };
}
