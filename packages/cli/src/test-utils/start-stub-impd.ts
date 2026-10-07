import { EXEC_PATH, ExecClientMessageSchema, decodeExecFrame, encodeExecFrame } from '@imp/api';
import type { ExecClientMessage, ExecServerMessage } from '@imp/api';
import { StandardRPCJsonSerializer } from '@orpc/client/standard';

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

// an RPC procedure's answer: a value, or the events of an event iterator
// and then its end
type StubRpcAnswer = { readonly output: unknown } | { readonly events: readonly unknown[] };

export interface StubImpdOptions {
  // scripts `/exec`: called with each message the client sends
  // oxlint-disable-next-line prefer-readonly-parameter-types -- the protocol's parsed messages are mutable
  readonly onExec?: (peer: StubImpdPeer, message: StubImpdReceived) => void;

  // `/rpc/<procedure>` answers, by procedure path such as `system/info`; a
  // procedure left out answers NOT_FOUND
  readonly rpc?: Readonly<Record<string, StubRpcAnswer>>;

  // the path impd sits under, as behind a proxy
  readonly prefix?: string;
}

const TOKEN = 'stub-impd-token';

// An impd on a loopback port, speaking the exec protocol and oRPC, for what
// the real impd never sends: a fault, or an older impd's answers. It takes
// only its own token, and records `/exec` messages and procedure calls.
export function startStubImpd(options: Readonly<StubImpdOptions> = {}) {
  const prefix = options.prefix ?? '';
  const received: StubImpdReceived[] = [];
  const calls: string[] = [];
  const paths: string[] = [];
  const closed = Promise.withResolvers<void>();

  const serializer = new StandardRPCJsonSerializer();

  const encodeRpc = (value: unknown) => {
    const [json, meta] = serializer.serialize(value);

    return { json, meta };
  };

  const buildRpcResponse = (procedure: string): Response => {
    const answer = options.rpc?.[procedure];

    if (answer === undefined) {
      const error = { defined: false, code: 'NOT_FOUND', status: 404, message: 'Not found' };

      return Response.json(encodeRpc(error), { status: 404 });
    }

    if ('output' in answer) {
      return Response.json(encodeRpc(answer.output));
    }

    const events = answer.events.map(
      (event) => `event: message\ndata: ${JSON.stringify(encodeRpc(event))}\n\n`,
    );

    return new Response(
      `${events.join('')}event: done\ndata: ${JSON.stringify(encodeRpc(undefined))}\n\n`,
      {
        headers: { 'content-type': 'text/event-stream' },
      },
    );
  };

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, bunServer) => {
      const path = new URL(request.url).pathname;

      paths.push(path);

      if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
        return Response.json(
          encodeRpc({ defined: false, code: 'UNAUTHORIZED', status: 401, message: 'Unauthorized' }),
          { status: 401 },
        );
      }

      if (path === `${prefix}${EXEC_PATH}`) {
        return bunServer.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 });
      }

      const procedure = path.slice(`${prefix}/rpc/`.length);

      calls.push(procedure);

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
    token: TOKEN,
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
