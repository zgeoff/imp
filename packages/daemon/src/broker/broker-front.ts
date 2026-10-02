import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { pipeline } from 'node:stream';
import type { BrokerPeer } from '../db/secrets';
import { findPeerSlot } from '../net/addressing';
import type { Subnet } from '../net/addressing';
import { readErrorMessage } from '../read-error-message';
import { MAX_HEAD_BYTES, findHeadEnd, parseConnectHead } from './connect-head';
import type { TerminatorKey } from './terminators';
import { TunnelRefusedError } from './tunnel-target';

// what the broker does with a CONNECT no grant covers; `open` tunnels it, and
// #26 adds the policies that refuse it
export const EGRESS_POLICIES = ['open'] as const;

// The front port every guest reaches on its own gateway. A CONNECT to a
// granted host goes to its TLS terminator; any other is a plain tunnel to a
// checked public address, while the imp's egress policy is `open`.

// the time a client has to send its CONNECT head
const HEAD_TIMEOUT_MS = 10_000;

// a dead guest's connections go once keepalive probes fail
const KEEPALIVE_MS = 60_000;

// connections one imp may hold open through the broker at once
const MAX_CONNECTIONS_PER_IMP = 256;

export interface BrokerFrontDeps {
  readonly subnet: Subnet;
  readonly findPeer: (slot: number) => Promise<BrokerPeer | undefined>;
  readonly isGranted: (impId: string, host: string) => Promise<boolean>;
  readonly openTerminator: (key: TerminatorKey) => Promise<string>;
  readonly resolveTunnelTarget: (host: string) => Promise<string>;
  readonly log: (message: string) => void;

  // opens a plain tunnel's upstream socket; tests point it at a local server
  readonly dialTunnel?: (address: string, port: number) => Socket;

  // smaller limits for tests
  readonly maxConnectionsPerImp?: number;
  readonly headTimeoutMs?: number;
}

export interface BrokerFront {
  readonly server: Server;
  readonly stop: () => Promise<void>;
}

// how many connections each imp holds open
interface ConnectionCounts {
  // false when the imp is at the cap
  readonly tryTake: (impId: string, max: number) => boolean;
  readonly release: (impId: string) => void;
}

function createConnectionCounts(): ConnectionCounts {
  const open = new Map<string, number>();

  return {
    tryTake: (impId, max) => {
      const count = open.get(impId) ?? 0;

      if (count >= max) {
        return false;
      }

      open.set(impId, count + 1);

      return true;
    },
    release: (impId) => {
      const left = (open.get(impId) ?? 1) - 1;

      if (left === 0) {
        open.delete(impId);
      } else {
        open.set(impId, left);
      }
    },
  };
}

export function startBrokerFront(port: number, deps: BrokerFrontDeps): Promise<BrokerFront> {
  const open = createConnectionCounts();

  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    // two pipelines and the bookkeeping here pass Node's default of 10
    // close listeners, which would only warn
    socket.setMaxListeners(32);
    sockets.add(socket);

    socket.once('close', () => {
      sockets.delete(socket);
    });

    socket.on('error', () => {});
    void handleConnection(socket, deps, open);
  });

  const ready = Promise.withResolvers<BrokerFront>();

  server.once('error', ready.reject);

  server.listen(port, '0.0.0.0', () => {
    ready.resolve({
      server,
      stop: async () => {
        const closed = Promise.withResolvers<void>();

        server.close(() => {
          closed.resolve();
        });

        for (const socket of sockets) {
          socket.destroy();
        }

        await closed.promise;
      },
    });
  });

  return ready.promise;
}

// a failure ends the connection and is logged; it never reaches the server
async function handleConnection(
  socket: Socket,
  deps: BrokerFrontDeps,
  open: ConnectionCounts,
): Promise<void> {
  try {
    await runConnection(socket, deps, open);
  } catch (error) {
    deps.log(`impd: broker: ${readErrorMessage(error)}`);
    socket.destroy();
  }
}

async function runConnection(
  socket: Socket,
  deps: BrokerFrontDeps,
  open: ConnectionCounts,
): Promise<void> {
  const slot = findPeerSlot(socket.remoteAddress ?? '', socket.localAddress ?? '', deps.subnet);

  // not a guest, or a guest on another imp's gateway
  if (slot === null) {
    socket.destroy();

    return;
  }

  const peer = await deps.findPeer(slot);

  if (peer === undefined) {
    socket.destroy();

    return;
  }

  if (!open.tryTake(peer.id, deps.maxConnectionsPerImp ?? MAX_CONNECTIONS_PER_IMP)) {
    sendReply(socket, 503, 'too many broker connections from this imp');

    return;
  }

  socket.once('close', () => {
    open.release(peer.id);
  });

  socket.setKeepAlive(true, KEEPALIVE_MS);

  const read = await readHead(socket, deps.headTimeoutMs ?? HEAD_TIMEOUT_MS);

  if (read === null) {
    socket.destroy();

    return;
  }

  const head = parseConnectHead(read.head);

  if (head.kind === 'refused') {
    sendReply(socket, head.status, head.reason);

    return;
  }

  const granted = head.port === 443 ? await deps.isGranted(peer.id, head.host) : false;

  if (granted) {
    const path = await deps.openTerminator({ impId: peer.id, host: head.host });

    startRelay(socket, createConnection({ path }), read.rest);

    return;
  }

  if (peer.egressPolicy !== 'open') {
    sendReply(socket, 403, `egress to ${head.host} is not allowed`);

    return;
  }

  let address: string;

  try {
    address = await deps.resolveTunnelTarget(head.host);
  } catch (error) {
    const status = error instanceof TunnelRefusedError ? 403 : 502;

    sendReply(socket, status, readErrorMessage(error));

    return;
  }

  const dialTunnel = deps.dialTunnel ?? ((host, port) => createConnection({ host, port }));

  startRelay(socket, dialTunnel(address, head.port), read.rest);
}

// The CONNECT head and any bytes after it, or null when the client sends
// too much, too slowly, or hangs up first.
interface HeadRead {
  readonly head: string;
  readonly rest: Uint8Array;
}

function readHead(socket: Socket, timeoutMs: number): Promise<HeadRead | null> {
  const done = Promise.withResolvers<HeadRead | null>();
  const chunks: Uint8Array[] = [];

  const resolveRead = (result: HeadRead | null): void => {
    clearTimeout(timer);

    socket.off('data', onData);
    socket.off('close', onClose);
    socket.pause();
    done.resolve(result);
  };

  const onData = (chunk: Uint8Array): void => {
    chunks.push(chunk);

    const buffered = Buffer.concat(chunks);
    const end = findHeadEnd(buffered);

    if (end !== null) {
      resolveRead({
        head: buffered.subarray(0, end).toString('latin1'),
        rest: buffered.subarray(end),
      });
    } else if (buffered.length > MAX_HEAD_BYTES) {
      resolveRead(null);
    }
  };

  const onClose = (): void => {
    resolveRead(null);
  };

  const timer = setTimeout(() => {
    resolveRead(null);
  }, timeoutMs);

  socket.on('data', onData);
  socket.once('close', onClose);

  return done.promise;
}

// answers once the far end is connected, then pipes both ways; pipeline
// carries backpressure and tears both down on an error
function startRelay(client: Socket, upstream: Socket, rest: Uint8Array): void {
  const state = { connected: false };

  upstream.once('connect', () => {
    state.connected = true;

    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    if (rest.length > 0) {
      upstream.write(rest);
    }

    pipeline(client, upstream, () => {
      upstream.destroy();
    });

    pipeline(upstream, client, () => {
      client.destroy();
    });
  });

  client.once('close', () => {
    if (!state.connected) {
      upstream.destroy();
    }
  });

  upstream.once('error', () => {
    if (!state.connected) {
      sendReply(client, 502, 'could not connect');
    }

    upstream.destroy();
  });
}

const REASONS: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  403: 'Forbidden',
  405: 'Method Not Allowed',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

function sendReply(socket: Socket, status: number, message: string): void {
  const body = `${message}\n`;

  socket.end(
    `HTTP/1.1 ${String(status)} ${REASONS[status] ?? 'Error'}\r\n` +
      `content-type: text/plain\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\n` +
      `connection: close\r\n\r\n${body}`,
  );
}
