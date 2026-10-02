import { afterEach, expect, test } from 'bun:test';
import { connect, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { TUNNEL_WINDOW_BYTES, TunnelClientMessageSchema } from '@imp/api';
import type { TunnelServerMessage } from '@imp/api';
import type { ServerWebSocket } from 'bun';
import type { CliConfig } from './cli-config';
import { startProxy } from './proxy-client';
import type { Proxy, ProxyIo } from './proxy-client';

const TOKEN = 'proxy-token';

interface FakeTunnelOptions {
  // a port that answers with this error instead of a connection
  readonly errors?: Readonly<Record<number, TunnelServerMessage>>;

  // false holds every ack, to see the client stop at the window
  readonly ack?: boolean;
}

interface FakeTunnelData {
  guest: Socket | null;
  received: number;
  peerEof: boolean;
  guestEof: boolean;
}

function sendControl(ws: ServerWebSocket<FakeTunnelData>, message: TunnelServerMessage): void {
  ws.send(JSON.stringify(message));
}

function stopWhenDone(ws: ServerWebSocket<FakeTunnelData>): void {
  if (ws.data.peerEof && ws.data.guestEof) {
    ws.close(1000, 'done');
  }
}

// An impd that serves only `/tunnel`: `open` connects to that port on this
// machine, which stands in for the guest, with the protocol's eofs and acks.
function startFakeTunnel(options: FakeTunnelOptions = {}) {
  const sockets: ServerWebSocket<FakeTunnelData>[] = [];
  const paths: string[] = [];

  const openGuest = (ws: ServerWebSocket<FakeTunnelData>, port: number): void => {
    const error = options.errors?.[port];

    if (error !== undefined) {
      sendControl(ws, error);

      ws.close(1000, 'tunnel failed');

      return;
    }

    const guest = connect({ host: '127.0.0.1', port, allowHalfOpen: true }, () => {
      ws.data.guest = guest;

      sendControl(ws, { type: 'opened' });
    });

    guest.on('data', (chunk: Buffer) => {
      ws.sendBinary(chunk);
    });

    guest.on('end', () => {
      ws.data.guestEof = true;

      sendControl(ws, { type: 'eof' });
      stopWhenDone(ws);
    });
  };

  const server = Bun.serve<FakeTunnelData>({
    port: 0,
    fetch: (request, bunServer) => {
      paths.push(new URL(request.url).pathname);

      if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
        return new Response('unauthorized', { status: 401 });
      }

      const data = { guest: null, received: 0, peerEof: false, guestEof: false };

      return bunServer.upgrade(request, { data }) ? undefined : new Response('', { status: 400 });
    },
    websocket: {
      open: (ws) => {
        sockets.push(ws);
      },
      message: (ws, message) => {
        if (typeof message !== 'string') {
          const guest = ws.data.guest;

          // data before `opened` breaks the protocol
          if (guest === null) {
            ws.close(1008, 'data before opened');

            return;
          }

          ws.data.received += message.byteLength;

          guest.write(message, () => {
            if (options.ack !== false) {
              sendControl(ws, { type: 'ack', bytes: message.byteLength });
            }
          });

          return;
        }

        const control = TunnelClientMessageSchema.parse(JSON.parse(message));

        if (control.type === 'open') {
          openGuest(ws, control.port);
        } else if (control.type === 'eof') {
          ws.data.peerEof = true;
          ws.data.guest?.end();
          stopWhenDone(ws);
        }
      },
      close: (ws) => {
        ws.data.guest?.destroy();
      },
    },
  });

  const config: CliConfig = {
    url: `http://127.0.0.1:${String(server.port)}/base`,
    token: TOKEN,
    host: null,
  };

  return { server, config, sockets, paths };
}

// the guest: reads a request to its end, then answers, as an HTTP/1.0 server
// may after a client's half-close
function startGuest(): Promise<{ server: Server; port: number }> {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const chunks: Buffer[] = [];

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    socket.on('end', () => {
      socket.end(`got ${String(Buffer.concat(chunks).byteLength)} bytes`);
    });
  });

  const started = Promise.withResolvers<{ server: Server; port: number }>();

  server.listen(0, '127.0.0.1', () => {
    const address = server.address();

    started.resolve({
      server,
      port: typeof address === 'object' && address !== null ? address.port : 0,
    });
  });

  return started.promise;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function createTestIo(missing = false) {
  const notices: string[] = [];
  const checked: string[] = [];

  const io: ProxyIo = {
    writeNotice: (text) => {
      notices.push(text);
    },
    checkImp: (_config, name) => {
      checked.push(name);

      return missing
        ? Promise.reject(new Error(`NOT_FOUND: no imp named ${name}`))
        : Promise.resolve();
    },
  };

  return { io, notices, checked };
}

async function startTestProxy(config: CliConfig, remote: number, io: ProxyIo): Promise<Proxy> {
  const proxy = await startProxy(config, 'box', [{ local: 0, remote }], io);

  cleanups.push(() => {
    proxy.stop();
  });

  return proxy;
}

// sends `body`, half-closes, and resolves with the reply once the far end
// closed
function sendRequest(host: string, port: number, body: Uint8Array): Promise<string> {
  const reply = Promise.withResolvers<string>();
  const socket = connect({ host, port, allowHalfOpen: true });
  let text = '';

  socket.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });

  socket.on('error', reply.reject);

  socket.on('close', () => {
    reply.resolve(text);
  });

  socket.end(body);

  return reply.promise;
}

test('a client that half-closes still gets the reply, on both loopbacks', async () => {
  const fake = startFakeTunnel();

  const guest = await startGuest();

  cleanups.push(() => {
    void fake.server.stop(true);
    guest.server.close();
  });

  const tested = createTestIo();

  const proxy = await startTestProxy(fake.config, guest.port, tested.io);

  const port = proxy.ports[0] ?? 0;

  const overIpv4 = await sendRequest('127.0.0.1', port, new TextEncoder().encode('hello'));
  const overIpv6 = await sendRequest('::1', port, new TextEncoder().encode('hi'));

  expect(overIpv4).toBe('got 5 bytes');
  expect(overIpv6).toBe('got 2 bytes');
  expect(fake.paths).toEqual(['/base/tunnel', '/base/tunnel']);
  expect(tested.checked).toEqual(['box']);
  expect(tested.notices).toEqual([]);
});

test('a large upload stops at the window until impd acks, then completes', async () => {
  const fake = startFakeTunnel({ ack: false });

  const guest = await startGuest();

  cleanups.push(() => {
    void fake.server.stop(true);
    guest.server.close();
  });

  const proxy = await startTestProxy(fake.config, guest.port, createTestIo().io);

  const size = 4 * TUNNEL_WINDOW_BYTES;
  const reply = sendRequest('127.0.0.1', proxy.ports[0] ?? 0, new Uint8Array(size));

  // the client sends the window, plus at most the read that crossed it
  for (
    let waited = 0;
    waited < 50 && (fake.sockets[0]?.data.received ?? 0) <= TUNNEL_WINDOW_BYTES;
    waited++
  ) {
    await Bun.sleep(10);
  }

  await Bun.sleep(100);

  const [ws] = fake.sockets;
  const held = ws?.data.received ?? 0;

  expect(held).toBeGreaterThan(TUNNEL_WINDOW_BYTES);
  expect(held).toBeLessThan(2 * TUNNEL_WINDOW_BYTES);
  ws?.send(JSON.stringify({ type: 'ack', bytes: size }));

  const replied = await reply;

  expect(replied).toBe(`got ${String(size)} bytes`);
});

test('a port in use fails at once, names the port, and calls no impd', async () => {
  const busy = await startGuest();

  cleanups.push(() => {
    busy.server.close();
  });

  const tested = createTestIo();
  const config: CliConfig = { url: 'http://127.0.0.1:1', token: TOKEN, host: null };
  const started = startProxy(config, 'box', [{ local: busy.port, remote: 5432 }], tested.io);

  expect(started).rejects.toThrow(
    `local port ${String(busy.port)} is in use; map another one: imp proxy box`,
  );

  await started.catch(() => null);

  expect(tested.checked).toEqual([]);
});

test('a missing imp fails the command and frees the port', async () => {
  const tested = createTestIo(true);
  const config: CliConfig = { url: 'http://127.0.0.1:1', token: TOKEN, host: null };

  const failure = await startProxy(config, 'nope', [{ local: 0, remote: 80 }], tested.io).catch(
    (error: unknown) => error,
  );

  expect(failure).toEqual(new Error('NOT_FOUND: no imp named nope'));
});

test('an error from impd reaches the user and resets the local connection', async () => {
  const fake = startFakeTunnel({
    errors: { 9: { type: 'error', code: 'AGENT_OUTDATED', message: 'stop and start the imp' } },
  });

  cleanups.push(() => {
    void fake.server.stop(true);
  });

  const tested = createTestIo();

  const proxy = await startTestProxy(fake.config, 9, tested.io);

  // a reset, as when the far end of a TCP connection refuses it
  expect(sendRequest('127.0.0.1', proxy.ports[0] ?? 0, new Uint8Array(1))).rejects.toThrow(
    'ECONNRESET',
  );

  await Bun.sleep(50);

  expect(tested.notices).toEqual(['box:9: AGENT_OUTDATED: stop and start the imp']);
});
