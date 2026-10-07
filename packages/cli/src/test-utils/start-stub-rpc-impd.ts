import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';

// an oRPC error as impd sends it: `defined` for the errors its contract
// declares, such as RAM_BUDGET_EXCEEDED with its numbers in `data`
interface StubRpcFailure {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly defined?: boolean;
  readonly data?: unknown;
}

// one request the stub got: its procedure ('imps/list'), the authorization
// header it carried, and its input as oRPC decodes it
interface StubRpcCall {
  readonly path: string;
  readonly authorization: string | null;
  readonly input: unknown;
}

export interface StubRpcImpdOptions {
  // the bearer token it takes; any other gets impd's 401
  readonly token: string;

  // each procedure's answer, by path; a procedure left out answers null
  readonly answers?: Readonly<Record<string, unknown>>;

  // procedures that fail instead of answering
  readonly failures?: Readonly<Record<string, StubRpcFailure>>;

  // takes every request and never answers, as an impd behind a stalled path
  readonly isSilent?: boolean;
}

const serializer = new StandardRPCSerializer(new StandardRPCJsonSerializer());

// A loopback impd speaking oRPC's RPC protocol from a table of answers, for
// the subprocess suites MSW cannot reach: an impd of another version, or in
// a state a real one cannot reach. It records every call.
export function startStubRpcImpd(options: Readonly<StubRpcImpdOptions>) {
  const calls: StubRpcCall[] = [];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      if (options.isSilent === true) {
        return new Promise<Response>(() => {
          // never answers
        });
      }

      const path = new URL(request.url).pathname.replace(/^\/rpc\//u, '');

      const authorization = request.headers.get('authorization');

      const text = await request.text();

      const body: unknown = text === '' ? undefined : JSON.parse(text);
      const input = body === undefined ? undefined : serializer.deserialize(body);

      calls.push({ path, authorization, input });

      if (authorization !== `Bearer ${options.token}`) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }

      const failure = options.failures?.[path];

      if (failure !== undefined) {
        const error = { defined: false, ...failure };

        return Response.json(serializer.serialize(error), { status: failure.status });
      }

      return Response.json(serializer.serialize(options.answers?.[path] ?? null));
    },
  });

  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    calls,
    [Symbol.dispose]: () => {
      void server.stop(true);
    },
  };
}
