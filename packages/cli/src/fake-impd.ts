import { encodeExecFrame } from '@imp/api';
import type { ExecServerMessage } from '@imp/api';

// what the client sent: a control message as parsed JSON, stdin as
// `{ stdin: text }`
export type FakeImpdReceived = Readonly<Record<string, unknown>>;

export interface FakeImpdPeer {
  readonly send: (message: ExecServerMessage) => void;
  readonly sendText: (text: string) => void;

  // any channel byte, so a test can send a bad one
  readonly sendFrame: (channel: number, text: string) => void;
  readonly close: (code?: number, reason?: string) => void;
}

export interface FakeImpd extends AsyncDisposable {
  readonly url: string;
  readonly token: string;
  readonly received: readonly FakeImpdReceived[];
  readonly paths: readonly string[];

  // resolves once the client's socket closed
  readonly closed: Promise<void>;
  readonly waitFor: (
    predicate: (received: readonly FakeImpdReceived[]) => boolean,
  ) => Promise<void>;
}

const TOKEN = 'fake-token';

// as long as the subprocess tests may take
const WAIT_TIMEOUT_MS = 20_000;

// An impd that serves only `/exec` (and a 401 or an empty answer on `/rpc`),
// for tests that drive the real exec client. `onMessage` scripts the replies.
export function startFakeImpd(
  onMessage: (peer: FakeImpdPeer, message: FakeImpdReceived) => void,
  prefix = '',
): FakeImpd {
  const received: FakeImpdReceived[] = [];
  const paths: string[] = [];
  const closed = Promise.withResolvers<void>();

  const server = Bun.serve({
    port: 0,
    fetch: (request, bunServer) => {
      paths.push(new URL(request.url).pathname);

      if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }

      if (new URL(request.url).pathname === `${prefix}/exec`) {
        return bunServer.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 });
      }

      return Response.json({});
    },
    websocket: {
      message: (ws, data) => {
        const message =
          typeof data === 'string'
            ? parseObject(data)
            : { stdin: new TextDecoder().decode(data.subarray(1)) };

        received.push(message);

        onMessage(
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
    url: `http://localhost:${String(server.port)}${prefix}`,
    token: TOKEN,
    received,
    paths,
    closed: closed.promise,
    waitFor: async (predicate) => {
      const deadline = Date.now() + WAIT_TIMEOUT_MS;

      while (!predicate(received)) {
        if (Date.now() > deadline) {
          throw new Error(`fake impd: timed out; received ${JSON.stringify(received)}`);
        }

        await Bun.sleep(5);
      }
    },
    [Symbol.asyncDispose]: async () => {
      await server.stop(true);
    },
  };
}

function parseObject(text: string): FakeImpdReceived {
  const value: unknown = JSON.parse(text);

  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}
