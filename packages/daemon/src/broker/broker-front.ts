import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { pipeline } from 'node:stream';
import type { EgressMode } from '@imp/api';
import type { BrokerPeer } from '../db/secrets';
import { isTunnelAllowed } from '../egress/egress-rules';
import { findPeerSlot } from '../net/addressing';
import type { Subnet } from '../net/addressing';
import { readErrorMessage } from '../read-error-message';
import { MAX_HEAD_BYTES, findHeadEnd, parseConnectHead } from './connect-head';
import type { TerminatorKey } from './terminators';
import { TunnelRefusedError } from './tunnel-target';

// The front port every guest reaches on its own gateway. A CONNECT to a
// granted host goes to its TLS terminator; any other is a plain tunnel to a
// checked public address, when the imp's egress policy allows the host.

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

  // the address to dial for a host, checked against what the imp's policy
  // refuses beyond every tunnel's ranges
  readonly resolveTunnelTarget: (host: string, mode: EgressMode) => Promise<string>;
  readonly log: (message: string) => void;

  // opens a plain tunnel's upstream socket; tests point it at a local server
  readonly dialTunnel?: (address: string, port: number) => Socket;

  // a smaller cap for tests
  readonly maxConnectionsPerImp?: number;

  // starts the deadline for a connection's head, given its length;
  // AbortSignal.timeout by default, and tests abort it themselves
  readonly startHeadDeadline?: (ms: number) => AbortSignal;
}

export interface BrokerFront {
  readonly server: Server;

  // the port it listens on: the one asked for, or the kernel's pick for 0
  readonly port: number;

  // ends the imp's plain tunnels to hosts `keep` rejects, as a tighter
  // egress policy needs: they are relays in impd, which conntrack never sees
  readonly closeTunnels: (impId: string, keep: (host: string) => boolean) => void;
  readonly stop: () => Promise<void>;
}

// Each imp's connections from accept, with their CONNECT's host once it
// comes. A policy change ends those with a host it denies, and leaves its
// `keep` on the rest for their tunnel start to check.
interface TunnelRegistry {
  readonly add: (impId: string, socket: Socket) => void;
  readonly setHost: (impId: string, socket: Socket, host: string) => void;

  // a connection to a granted host, which every policy allows
  readonly drop: (impId: string, socket: Socket) => void;

  // false once a policy change denies the host, or the connection ended
  readonly isKept: (impId: string, socket: Socket, host: string) => boolean;
  readonly closeDenied: (impId: string, keep: (host: string) => boolean) => void;
}

interface TunnelEntry {
  host: string | null;
  keep: ((host: string) => boolean) | null;
}

function createTunnelRegistry(): TunnelRegistry {
  const tunnels = new Map<string, Map<Socket, TunnelEntry>>();

  return {
    add: (impId, socket) => {
      const own = tunnels.get(impId) ?? new Map<Socket, TunnelEntry>();

      tunnels.set(impId, own);
      own.set(socket, { host: null, keep: null });

      socket.once('close', () => {
        own.delete(socket);

        if (own.size === 0 && tunnels.get(impId) === own) {
          tunnels.delete(impId);
        }
      });
    },
    setHost: (impId, socket, host) => {
      const entry = tunnels.get(impId)?.get(socket);

      if (entry !== undefined) {
        entry.host = host;
      }
    },
    drop: (impId, socket) => {
      tunnels.get(impId)?.delete(socket);
    },
    isKept: (impId, socket, host) => {
      const entry = tunnels.get(impId)?.get(socket);

      return !socket.destroyed && entry !== undefined && (entry.keep?.(host) ?? true);
    },
    closeDenied: (impId, keep) => {
      for (const [socket, entry] of tunnels.get(impId) ?? []) {
        entry.keep = keep;

        if (entry.host !== null && !keep(entry.host)) {
          socket.destroy();
        }
      }
    },
  };
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
  const tunnels = createTunnelRegistry();

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
    void handleConnection(socket, deps, open, tunnels);
  });

  const ready = Promise.withResolvers<BrokerFront>();

  server.once('error', ready.reject);

  server.listen(port, '0.0.0.0', () => {
    const address = server.address();

    ready.resolve({
      server,
      port: typeof address === 'object' && address !== null ? address.port : port,
      closeTunnels: tunnels.closeDenied,
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
  tunnels: TunnelRegistry,
): Promise<void> {
  try {
    await runConnection(socket, deps, open, tunnels);
  } catch (error) {
    deps.log(`impd: broker: ${readErrorMessage(error)}`);
    socket.destroy();
  }
}

async function runConnection(
  socket: Socket,
  deps: BrokerFrontDeps,
  open: ConnectionCounts,
  tunnels: TunnelRegistry,
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
  tunnels.add(peer.id, socket);

  const startHeadDeadline = deps.startHeadDeadline ?? ((ms: number) => AbortSignal.timeout(ms));
  const deadline = startHeadDeadline(HEAD_TIMEOUT_MS);

  const read = await readHead(socket, deadline);

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
    tunnels.drop(peer.id, socket);

    const path = await deps.openTerminator({ impId: peer.id, host: head.host });

    startRelay(socket, createConnection({ path }), read.rest);

    return;
  }

  tunnels.setHost(peer.id, socket, head.host);

  // the policy as it is now: it may have changed while the head was coming
  const current = await deps.findPeer(slot);

  if (current?.id !== peer.id) {
    socket.destroy();

    return;
  }

  if (!isTunnelAllowed(current.egress, head.host)) {
    sendReply(socket, 403, `egress to ${head.host} is not allowed by the imp's egress policy`);

    return;
  }

  let address: string;

  try {
    address = await deps.resolveTunnelTarget(head.host, current.egress.mode);
  } catch (error) {
    const status = error instanceof TunnelRefusedError ? 403 : 502;

    sendReply(socket, status, readErrorMessage(error));

    return;
  }

  if (!tunnels.isKept(peer.id, socket, head.host)) {
    if (!socket.destroyed) {
      sendReply(socket, 403, `egress to ${head.host} is not allowed by the imp's egress policy`);
    }

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

function readHead(socket: Socket, deadline: AbortSignal): Promise<HeadRead | null> {
  const done = Promise.withResolvers<HeadRead | null>();
  const chunks: Uint8Array[] = [];

  const resolveRead = (result: HeadRead | null): void => {
    deadline.removeEventListener('abort', onDeadline);
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

  const onDeadline = (): void => {
    resolveRead(null);
  };

  if (deadline.aborted) {
    resolveRead(null);

    return done.promise;
  }

  deadline.addEventListener('abort', onDeadline, { once: true });
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
