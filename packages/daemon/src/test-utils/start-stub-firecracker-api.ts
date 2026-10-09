import { onTestFinished } from 'bun:test';

interface StubFirecrackerAnswer {
  readonly status: number;

  // the body as Firecracker sends it; a value is sent as JSON
  readonly body?: unknown;
}

interface StubFirecrackerApiOptions {
  // answers by `<METHOD> <path>`; any other call gets 204 and no body, as
  // Firecracker answers a PUT or PATCH it takes
  readonly answers?: Readonly<Record<string, StubFirecrackerAnswer>>;

  // true: it takes each request and never answers, like a wedged VMM
  readonly isWedged?: boolean;
}

interface StubFirecrackerCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

// Firecracker's HTTP API on its unix socket at `socketPath`. `calls` records
// each request with its parsed JSON body, or null for none. It stops when
// the test ends.
export function startStubFirecrackerApi(
  socketPath: string,
  options: Readonly<StubFirecrackerApiOptions> = {},
) {
  const calls: StubFirecrackerCall[] = [];

  const server = Bun.serve({
    unix: socketPath,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;

      const text = await request.text();

      calls.push({ method: request.method, path, body: text === '' ? null : JSON.parse(text) });

      if (options.isWedged === true) {
        return new Promise<Response>(() => {});
      }

      const answer = options.answers?.[`${request.method} ${path}`];

      if (answer === undefined) {
        return new Response(null, { status: 204 });
      }

      const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);

      return new Response(body, { status: answer.status });
    },
  });

  onTestFinished(() => server.stop(true));

  return { calls };
}
