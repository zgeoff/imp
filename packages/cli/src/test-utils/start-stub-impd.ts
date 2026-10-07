import { EXEC_PATH, ExecClientMessageSchema, decodeExecFrame, encodeExecFrame } from '@imp/api';
import type { ExecClientMessage, ExecServerMessage } from '@imp/api';
import { StandardRPCJsonSerializer, StandardRPCSerializer } from '@orpc/client/standard';

// what the client sent over `/exec`: a control message as the protocol
// parses it, or a stdin frame as text and its byte count
type StubImpdReceived =
  | ExecClientMessage
  | { readonly type: 'stdin'; readonly text: string; readonly bytes: number };

interface StubImpdPeer {
  readonly send: (message: ExecServerMessage) => void;

  // any text, so a test can send one the protocol has no schema for
  readonly sendText: (text: string) => void;

  // any channel byte, so a test can send one the protocol does not use
  readonly sendFrame: (channel: number, text: string) => void;
  readonly close: (code?: number, reason?: string) => void;
}

// an oRPC error as impd sends it: `defined` for the errors its contract
// declares, such as RAM_BUDGET_EXCEEDED with its numbers in `data`
interface StubRpcFailure {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly defined?: boolean;
  readonly data?: unknown;
}

// one procedure call the stub got: its path ('imps/list'), the authorization
// header it carried, and its input as oRPC decodes it
interface StubRpcCall {
  readonly path: string;
  readonly authorization: string | null;
  readonly input: unknown;
}

export interface StubImpdOptions {
  // the bearer token it takes; any other gets impd's 401
  readonly token?: string;

  // each procedure's answer, by path such as `system/info`; a procedure
  // left out of every table answers null
  readonly answers?: Readonly<Record<string, unknown>>;

  // event-iterator procedures: each event, then the iterator's end
  readonly streams?: Readonly<Record<string, readonly unknown[]>>;

  // procedures that fail with an oRPC error instead of answering
  readonly failures?: Readonly<Record<string, StubRpcFailure>>;

  // takes every request and never answers, as an impd behind a stalled path
  readonly isSilent?: boolean;

  // scripts `/exec`: called with each message the client sends
  // oxlint-disable-next-line prefer-readonly-parameter-types -- the protocol's parsed messages are mutable
  readonly onExec?: (peer: StubImpdPeer, message: StubImpdReceived) => void;

  // the path impd sits under, as behind a proxy
  readonly prefix?: string;
}

const DEFAULT_TOKEN = 'stub-impd-token';

const serializer = new StandardRPCSerializer(new StandardRPCJsonSerializer());

// A loopback impd speaking the exec protocol and oRPC, for what a real impd
// never sends (a fault, an older impd's answers) or a subprocess CLI's state
// a real one cannot reach. It records every call and `/exec` message.
export function startStubImpd(options: Readonly<StubImpdOptions> = {}) {
  const prefix = options.prefix ?? '';
  const token = options.token ?? DEFAULT_TOKEN;
  const received: StubImpdReceived[] = [];
  const calls: StubRpcCall[] = [];
  const paths: string[] = [];
  const closed = Promise.withResolvers<void>();

  const buildRpcResponse = (procedure: string): Response => {
    const failure = options.failures?.[procedure];

    if (failure !== undefined) {
      return Response.json(serializer.serialize({ defined: false, ...failure }), {
        status: failure.status,
      });
    }

    const events = options.streams?.[procedure];

    if (events === undefined) {
      return Response.json(serializer.serialize(options.answers?.[procedure] ?? null));
    }

    const lines = events.map(
      (event) => `event: message\ndata: ${JSON.stringify(serializer.serialize(event))}\n\n`,
    );

    return new Response(
      `${lines.join('')}event: done\ndata: ${JSON.stringify(serializer.serialize(undefined))}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request, bunServer) => {
      if (options.isSilent === true) {
        return new Promise<Response>(() => {
          // never answers
        });
      }

      const path = new URL(request.url).pathname;

      const authorization = request.headers.get('authorization');
      const isAuthorized = authorization === `Bearer ${token}`;

      paths.push(path);

      if (path === `${prefix}${EXEC_PATH}`) {
        if (!isAuthorized) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        return bunServer.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 });
      }

      const text = await request.text();

      const body: unknown = text === '' ? undefined : JSON.parse(text);
      const input = body === undefined ? undefined : serializer.deserialize(body);
      const procedure = path.slice(`${prefix}/rpc/`.length);

      calls.push({ path: procedure, authorization, input });

      if (!isAuthorized) {
        const error = {
          defined: false,
          code: 'UNAUTHORIZED',
          status: 401,
          message: 'Unauthorized',
        };

        return Response.json(serializer.serialize(error), { status: 401 });
      }

      return buildRpcResponse(procedure);
    },
    websocket: {
      message: (ws, data) => {
        const stdin = typeof data === 'string' ? null : decodeExecFrame(data).data;

        const message: StubImpdReceived =
          stdin === null
            ? ExecClientMessageSchema.parse(JSON.parse(String(data)))
            : { type: 'stdin', text: new TextDecoder().decode(stdin), bytes: stdin.byteLength };

        received.push(message);

        options.onExec?.(
          {
            send: (reply) => {
              ws.send(JSON.stringify(reply));
            },
            sendText: (text) => {
              ws.send(text);
            },
            sendFrame: (channel, text) => {
              const frame = encodeExecFrame(0, new TextEncoder().encode(text));

              frame[0] = channel;

              ws.send(frame);
            },
            close: (code, reason) => {
              ws.close(code, reason);
            },
          },
          message,
        );
      },
      close: () => {
        closed.resolve();
      },
    },
  });

  return {
    url: `http://127.0.0.1:${String(server.port)}${prefix}`,
    token,
    received,
    calls,
    paths,

    // resolves once a client's exec socket closed
    closed: closed.promise,
    [Symbol.dispose]: () => {
      // force-closes every connection at once; the port's release needs no wait
      void server.stop(true);
    },
  };
}
