import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { TUNNEL_CLOSE_LOST, TunnelClientMessageSchema } from '@imp/api';
import type { ImpState, TunnelClientMessage, TunnelServerMessage } from '@imp/api';
import type { ServerWebSocket } from 'bun';
import type { CliConfig } from './cli-config';
import { parseReverse } from './parse-reverse';
import { startReverseForward } from './reverse-client';
import type { ReverseIo } from './reverse-client';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const decoder = new TextDecoder();

function sendServer(ws: ServerWebSocket, message: TunnelServerMessage): void {
  ws.send(JSON.stringify(message));
}

interface FakeImpdOptions {
  // the answer to a listen, by its turn: an error instead of `listening`
  readonly refuse?: (turn: number) => TunnelServerMessage | null;
}

// An impd that serves only `/tunnel`. A listen answers `listening`; an
// accept relays to a stand-in guest client that sends `hello`, keeps what
// comes back, and closes its side once the local side did.
function startFakeImpd(options: FakeImpdOptions = {}) {
  const controls: ServerWebSocket[] = [];
  const received: TunnelClientMessage[] = [];
  const replies: string[] = [];

  const server = Bun.serve({
    port: 0,
    fetch: (request, bunServer) =>
      bunServer.upgrade(request) ? undefined : new Response('', { status: 400 }),
    websocket: {
      message: (ws, message) => {
        if (typeof message !== 'string') {
          sendServer(ws, { type: 'ack', bytes: message.byteLength });

          replies.push(decoder.decode(message));

          return;
        }

        const control = TunnelClientMessageSchema.parse(JSON.parse(message));

        received.push(control);

        if (control.type === 'listen') {
          const refusal = options.refuse?.(controls.length) ?? null;

          controls.push(ws);

          if (refusal === null) {
            sendServer(ws, { type: 'listening', listener: 'fwd1', path: null, port: 9000 });
          } else {
            sendServer(ws, refusal);

            ws.close(1000, 'refused');
          }
        } else if (control.type === 'accept') {
          sendServer(ws, { type: 'opened' });

          ws.send(new TextEncoder().encode('hello'));
        } else if (control.type === 'eof') {
          sendServer(ws, { type: 'eof' });

          ws.close(1000, 'done');
        }
      },
    },
  });

  cleanups.push(() => {
    void server.stop(true);
  });

  const config: CliConfig = {
    url: `http://127.0.0.1:${String(server.port)}`,
    token: 'secret',
    host: null,
  };

  return { config, controls, received, replies };
}

// a local unix socket server that answers each line in capitals and closes
function startLocalServer(): string {
  const dir = mkdtempSync(join(process.env['TMPDIR'] ?? '/tmp', 'reverse-'));
  const path = join(dir, 'app.sock');

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('data', (chunk: Buffer) => {
      socket.end(chunk.toString().toUpperCase());
    });
  });

  server.listen(path);

  cleanups.push(() => {
    server.close();

    rmSync(dir, { recursive: true, force: true });
  });

  return path;
}

// the imp's states as a test pushes them; ends when the forward stops
function createStates() {
  const queue: ImpState[] = [];
  const waiting: (() => void)[] = [];
  const opened = { count: 0 };

  const sendState = (state: ImpState): void => {
    queue.push(state);

    for (const wake of waiting.splice(0)) {
      wake();
    }
  };

  const readStates = (signal: AbortSignal): AsyncIterable<ImpState> => {
    opened.count += 1;

    const readNext = async (): Promise<IteratorResult<ImpState>> => {
      while (!signal.aborted) {
        const state = queue.shift();

        if (state !== undefined) {
          return { done: false, value: state };
        }

        await new Promise<void>((resolve) => {
          waiting.push(resolve);

          signal.addEventListener('abort', () => {
            resolve();
          });
        });
      }

      return { done: true, value: undefined };
    };

    return { [Symbol.asyncIterator]: () => ({ next: readNext }) };
  };

  return { sendState, readStates, opened };
}

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out');
    }

    await Bun.sleep(5);
  }
}

function buildIo(
  readStates: (signal: AbortSignal) => AsyncIterable<ImpState>,
  writeNotice: (text: string) => void = () => {},
): ReverseIo {
  return {
    writeNotice,
    watchImp: (_config, _name, signal) => readStates(signal),
    lostGraceMs: 100,
    retryMs: 10,
  };
}

test('a client in the imp reaches the local unix socket, both ways', async () => {
  const impd = startFakeImpd();
  const path = startLocalServer();
  const states = createStates();

  const forwarding = await startReverseForward(
    impd.config,
    'box',
    parseReverse(`:${path}`),
    buildIo(states.readStates),
  );

  cleanups.push(forwarding.stop);

  const [control] = impd.controls;

  if (control === undefined) {
    throw new Error('no control socket');
  }

  sendServer(control, { type: 'connection', id: 1 });

  await waitUntil(() => impd.replies.length > 0);

  expect(forwarding.listening).toEqual({ path: null, port: 9000 });
  expect(impd.replies).toEqual(['HELLO']);
  expect(impd.received[0]).toEqual({ type: 'listen', name: 'box', network: 'unix', path: null });

  expect(impd.received).toContainEqual({
    type: 'accept',
    name: 'box',
    listener: 'fwd1',
    connection: 1,
  });
});

test('a lost forward waits for the imp to sleep and wake, then listens again', async () => {
  const impd = startFakeImpd();
  const states = createStates();
  const notices: string[] = [];

  const forwarding = await startReverseForward(
    impd.config,
    'box',
    parseReverse('9000:8080'),
    buildIo(states.readStates, (text) => {
      notices.push(text);
    }),
  );

  cleanups.push(forwarding.stop);
  states.sendState('running');
  impd.controls[0]?.close(TUNNEL_CLOSE_LOST, 'lost');

  await waitUntil(() => states.opened.count === 1);

  // the snapshot said running; asleep within the grace, it waits for a wake
  states.sendState('sleeping');

  await Bun.sleep(150);

  expect(impd.controls).toHaveLength(1);

  states.sendState('running');

  await waitUntil(() => impd.controls.length === 2);
  await waitUntil(() => notices.length === 2);

  expect(notices[1]).toBe('forwarding box:9000 -> localhost:8080 again');
});

test('a lost forward on an imp that stays running listens again after the grace', async () => {
  const impd = startFakeImpd();
  const states = createStates();

  const forwarding = await startReverseForward(
    impd.config,
    'box',
    parseReverse('9000'),
    buildIo(states.readStates),
  );

  cleanups.push(forwarding.stop);
  states.sendState('running');
  impd.controls[0]?.close(TUNNEL_CLOSE_LOST, 'lost');

  await waitUntil(() => impd.controls.length === 2);
});

test('a refused listen fails the forward with the code', async () => {
  const impd = startFakeImpd({
    refuse: () => ({
      type: 'error',
      code: 'LISTEN_FAILED',
      message: 'the directory /nope does not exist in the imp',
    }),
  });

  const states = createStates();

  const starting = startReverseForward(
    impd.config,
    'box',
    parseReverse('/nope/app.sock:9000'),
    buildIo(states.readStates),
  );

  let message = '';

  try {
    await starting;
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }

  expect(message).toBe(
    'reverse forward to localhost:9000: LISTEN_FAILED: the directory /nope does not exist in the imp',
  );
});

test('a listen refused after a wake fails the forward for good', async () => {
  const impd = startFakeImpd({
    refuse: (turn) =>
      turn === 0 ? null : { type: 'error', code: 'ACCESS_DENIED', message: 'no exec on box' },
  });

  const states = createStates();

  const forwarding = await startReverseForward(
    impd.config,
    'box',
    parseReverse('9000'),
    buildIo(states.readStates),
  );

  cleanups.push(forwarding.stop);
  states.sendState('sleeping');
  impd.controls[0]?.close(TUNNEL_CLOSE_LOST, 'lost');
  states.sendState('running');

  const failure = await forwarding.failed;

  expect(failure.message).toBe('reverse forward to localhost:9000: ACCESS_DENIED: no exec on box');
});

test('stop ends the forward and the wait for a wake', async () => {
  const impd = startFakeImpd();
  const states = createStates();

  const forwarding = await startReverseForward(
    impd.config,
    'box',
    parseReverse('9000'),
    buildIo(states.readStates),
  );

  states.sendState('sleeping');
  impd.controls[0]?.close(TUNNEL_CLOSE_LOST, 'lost');

  await waitUntil(() => states.opened.count === 1);

  forwarding.stop();
  states.sendState('running');

  await Bun.sleep(50);

  expect(impd.controls).toHaveLength(1);
});
