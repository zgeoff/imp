import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import {
  TUNNEL_CLOSE_LOST,
  TUNNEL_PATH,
  TUNNEL_WINDOW_BYTES,
  TunnelServerMessageSchema,
} from '@imp/api';
import type { TunnelClientMessage, TunnelServerMessage } from '@imp/api';
import { loadCliConfig } from './cli-config';
import type { CliConfig } from './cli-config';
import { createImpClient } from './create-imp-client';
import { parseForward } from './parse-forward';
import type { Forward } from './parse-forward';
import { printError } from './run-action';

// what runProxy touches besides the network; tests swap it
export interface ProxyIo {
  // a line for the user on stderr, after `imp: `
  readonly writeNotice: (text: string) => void;

  // throws when the imp does not exist; it must not wake the imp
  readonly checkImp: (config: CliConfig, name: string) => Promise<void>;
}

export interface Proxy {
  // the port each forward listens on, in order: a local 0 resolves here
  readonly ports: readonly number[];
  readonly stop: () => void;
}

// WebSocket close codes the tunnel uses besides TUNNEL_CLOSE_LOST
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL = 1008;
const CLOSE_RESTARTING = 1012;

// a busy port fails the command; a machine with no IPv6 loopback serves IPv4
const NO_IPV6_CODES = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

const PROCESS_IO: ProxyIo = {
  writeNotice: (text) => {
    console.error(`imp: ${text}`);
  },
  checkImp: async (config, name) => {
    await createImpClient(config).imps.get({ name });
  },
};

// the same join as the client's resolveImpdUrl: a base path such as
// https://host/imp stays in front of /tunnel
function buildTunnelUrl(base: string): string {
  const url = new URL(base);

  url.pathname = `${url.pathname.replace(/\/+$/, '')}${TUNNEL_PATH}`;
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  return url.toString();
}

function readErrorCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

function buildBindError(error: unknown, name: string, forward: Forward): Error {
  const code = readErrorCode(error);
  const remote = String(forward.remote);
  const local = String(forward.local);

  if (code === 'EADDRINUSE') {
    const other = forward.local + 10_000 > 65_535 ? 0 : forward.local + 10_000;

    return new Error(
      `local port ${local} is in use; map another one: imp proxy ${name} ${String(other)}:${remote} (0:${remote} takes any free port)`,
    );
  }

  if (code === 'EACCES') {
    return new Error(
      `local port ${local} needs privileges; map a port above 1023: imp proxy ${name} 8${remote.padStart(3, '0')}:${remote}`,
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

function formatClose(code: number): string {
  if (code === TUNNEL_CLOSE_LOST) {
    return 'the connection in the imp was lost';
  }

  if (code === CLOSE_RESTARTING) {
    return 'impd restarted';
  }

  if (code === CLOSE_PROTOCOL) {
    return 'impd broke the tunnel protocol';
  }

  return `impd closed the tunnel (code ${String(code)})`;
}

function startListener(server: Server, port: number, host: string): Promise<number> {
  const listening = Promise.withResolvers<number>();

  server.once('error', listening.reject);

  server.listen(port, host, () => {
    server.off('error', listening.reject);

    const address = server.address();
    const bound = typeof address === 'object' && address !== null ? address.port : port;

    listening.resolve(bound);
  });

  return listening.promise;
}

// both loopbacks, so `localhost` works whichever address it resolves to
async function startForward(
  name: string,
  forward: Forward,
  onConnection: (socket: Socket, remote: number) => void,
): Promise<{ readonly port: number; readonly servers: readonly Server[] }> {
  const createListener = (): Server =>
    createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => {
      onConnection(socket, forward.remote);
    });

  const ipv4 = createListener();
  let port: number;

  try {
    port = await startListener(ipv4, forward.local, '127.0.0.1');
  } catch (error) {
    throw buildBindError(error, name, forward);
  }

  const ipv6 = createListener();

  try {
    await startListener(ipv6, port, '::1');

    return { port, servers: [ipv4, ipv6] };
  } catch (error) {
    if (NO_IPV6_CODES.has(readErrorCode(error) ?? '')) {
      return { port, servers: [ipv4] };
    }

    ipv4.close();
    throw buildBindError(error, name, { local: port, remote: forward.remote });
  }
}

interface TunnelTarget {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly name: string;
  readonly port: number;
}

// One local TCP connection over its own `/tunnel` WebSocket. The socket
// stays paused until impd answers `opened`, and pauses again while more than
// TUNNEL_WINDOW_BYTES of its bytes wait for an ack. Returns a stop.
function openTunnel(socket: Socket, target: TunnelTarget, io: ProxyIo): () => void {
  const ws = new WebSocket(target.url, { headers: { ...target.headers } });

  const label = `${target.name}:${String(target.port)}`;
  const state = { opened: false, unacked: 0, reported: false };

  ws.binaryType = 'arraybuffer';

  const send = (message: TunnelClientMessage): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  const handleControl = (message: TunnelServerMessage): void => {
    if (message.type === 'opened') {
      state.opened = true;

      socket.resume();
    } else if (message.type === 'eof') {
      socket.end();
    } else if (message.type === 'ack') {
      state.unacked -= message.bytes;

      if (state.unacked <= TUNNEL_WINDOW_BYTES && state.opened) {
        socket.resume();
      }
    } else {
      state.reported = true;

      io.writeNotice(`${label}: ${message.code ?? 'error'}: ${message.message}`);
      socket.destroy();
    }
  };

  const handleData = (data: Uint8Array): void => {
    socket.write(data, () => {
      send({ type: 'ack', bytes: data.byteLength });
    });
  };

  ws.addEventListener('open', () => {
    send({ type: 'open', name: target.name, port: target.port });
  });

  ws.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) {
      handleData(new Uint8Array(event.data));

      return;
    }

    const parsed = TunnelServerMessageSchema.safeParse(JSON.parse(String(event.data)));

    if (parsed.success) {
      handleControl(parsed.data);
    } else {
      ws.close(CLOSE_PROTOCOL, 'bad message');
    }
  });

  ws.addEventListener('close', (event) => {
    if (event.code === CLOSE_NORMAL) {
      socket.end();

      return;
    }

    if (!state.reported) {
      io.writeNotice(`${label}: ${formatClose(event.code)}`);
    }

    socket.destroy();
  });

  socket.on('data', (chunk: Buffer) => {
    ws.send(chunk);

    state.unacked += chunk.byteLength;

    if (state.unacked > TUNNEL_WINDOW_BYTES) {
      socket.pause();
    }
  });

  // a TCP half-close: the reply may still come back
  socket.on('end', () => {
    send({ type: 'eof' });
  });

  // 'close' follows an error, and ends the tunnel
  socket.on('error', () => {});

  socket.on('close', () => {
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
      ws.close(CLOSE_NORMAL, 'local connection closed');
    }
  });

  return () => {
    socket.destroy();
  };
}

// Listens on each forward's local port on 127.0.0.1 and ::1 first, so a
// busy port fails at once, then checks the imp exists without waking it.
// Each connection then opens a tunnel, which wakes the imp.
export async function startProxy(
  config: CliConfig,
  name: string,
  forwards: readonly Forward[],
  io: ProxyIo = PROCESS_IO,
): Promise<Proxy> {
  const servers: Server[] = [];

  const tunnels = new Set<() => void>();

  const ports: number[] = [];
  const state = { ready: false };

  const target = {
    url: buildTunnelUrl(config.url),
    headers: config.token === null ? {} : { authorization: `Bearer ${config.token}` },
    name,
  };

  const handleConnection = (socket: Socket, remote: number): void => {
    // a connection before the imp check passed
    if (!state.ready) {
      socket.destroy();

      return;
    }

    const stopTunnel = openTunnel(socket, { ...target, port: remote }, io);

    tunnels.add(stopTunnel);

    socket.on('close', () => {
      tunnels.delete(stopTunnel);
    });
  };

  const stop = (): void => {
    for (const server of servers) {
      server.close();
    }

    for (const stopTunnel of tunnels) {
      stopTunnel();
    }
  };

  try {
    for (const forward of forwards) {
      const started = await startForward(name, forward, handleConnection);

      servers.push(...started.servers);
      ports.push(started.port);
    }

    await io.checkImp(config, name);
  } catch (error) {
    stop();
    throw error;
  }

  state.ready = true;

  return { ports, stop };
}

export interface ProxyOptions {
  // the saved host `--host` named, or null
  readonly host: string | null;
  readonly name: string;
  readonly specs: readonly string[];
}

// `imp proxy`: runs until SIGINT or SIGTERM, then exits 0
export async function runProxy(options: ProxyOptions, io: ProxyIo = PROCESS_IO): Promise<void> {
  let config: CliConfig | null = null;
  let proxy: Proxy;

  try {
    config = loadCliConfig(process.env, options.host);

    const forwards = options.specs.map((spec) => parseForward(spec));

    proxy = await startProxy(config, options.name, forwards, io);

    for (const [index, forward] of forwards.entries()) {
      console.log(
        `forwarding localhost:${String(proxy.ports[index])} -> ${options.name}:${String(forward.remote)}`,
      );
    }
  } catch (error) {
    printError(error, config);

    return;
  }

  const stopped = Promise.withResolvers<void>();

  process.once('SIGINT', stopped.resolve);
  process.once('SIGTERM', stopped.resolve);

  await stopped.promise;

  proxy.stop();
}
