import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { TUNNEL_CLOSE_LOST, TUNNEL_CLOSE_PROTOCOL, TUNNEL_CLOSE_RESTARTING } from '@impz/api';
import { openForwardTunnel } from '@impz/client';
import type { ForwardTunnelEnd, ForwardTunnelOptions } from '@impz/client';
import { match } from 'ts-pattern';
import { loadCliConfig } from './cli-config';
import type { CliConfig } from './cli-config';
import { createImpClient } from './create-imp-client';
import { openBunWebSocket } from './open-bun-web-socket';
import { parseForward } from './parse-forward';
import type { Forward } from './parse-forward';
import { parseReverse } from './parse-reverse';
import { formatGuest, formatLocal, startReverseForward } from './reverse-client';
import type { ReverseIo } from './reverse-client';
import { printError } from './run-action';
import { UsageError } from './usage-error';

// what runProxy touches besides the network; tests swap it
export interface ProxyIo {
  // a line for the user on stderr, after `impz: `
  readonly writeNotice: (text: string) => void;

  // the clock the quiet time between unreachable notices runs on; Date.now
  // by default
  readonly now?: () => number;

  // for `--reverse`; undefined for the process's own
  readonly reverse?: ReverseIo;

  // told the bytes still waiting for impd's acks each time a connection
  // stops reading at the window; nothing by default
  readonly onWindowFull?: (unackedBytes: number) => void;

  // opens each tunnel's socket; Bun's WebSocket by default
  readonly connect?: ForwardTunnelOptions['connect'];
}

export interface Proxy {
  // the port each forward listens on, in order: a local 0 resolves here
  readonly ports: readonly number[];
  readonly stop: () => void;
}

// one notice for a burst of connections that cannot reach impd: another
// comes only after this long without a failure
const UNREACHABLE_QUIET_MS = 5000;

// a local port 0 whose IPv4 port is taken on ::1 tries a new one this often
const FREE_PORT_TRIES = 5;

// a busy port fails the command; a machine with no IPv6 loopback serves IPv4
const NO_IPV6_CODES = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

// throws when the imp does not exist; imps.get never wakes the imp
async function checkImpExists(config: CliConfig, name: string): Promise<void> {
  await createImpClient(config).imps.get({ name });
}

const PROCESS_IO: ProxyIo = {
  writeNotice: (text) => {
    console.error(`impz: ${text}`);
  },
};

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
      `local port ${local} is in use; map another one: impz proxy ${name} ${String(other)}:${remote} (0:${remote} takes any free port)`,
    );
  }

  // a port below 1024; plus 8000 keeps it recognisable (80 to 8080)
  if (code === 'EACCES') {
    return new Error(
      `local port ${local} needs privileges; map a port above 1023: impz proxy ${name} ${String(forward.local + 8000)}:${remote}`,
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

// what a tunnel's close code means for the user
export function formatTunnelClose(code: number): string {
  if (code === TUNNEL_CLOSE_LOST) {
    return 'the connection in the imp was lost';
  }

  if (code === TUNNEL_CLOSE_RESTARTING) {
    return 'impd restarted';
  }

  if (code === TUNNEL_CLOSE_PROTOCOL) {
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

interface StartedForward {
  readonly port: number;
  readonly servers: readonly Server[];
}

// both loopbacks, so `localhost` works whichever address it resolves to
async function startForward(
  name: string,
  forward: Forward,
  onConnection: (socket: Socket, remote: number) => void,
): Promise<StartedForward> {
  const createListener = (): Server =>
    createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => {
      onConnection(socket, forward.remote);
    });

  for (let tries = 1; ; tries++) {
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
      const code = readErrorCode(error) ?? '';

      if (NO_IPV6_CODES.has(code)) {
        return { port, servers: [ipv4] };
      }

      ipv4.close();

      // any free port: the next one may be free on ::1 too
      if (forward.local === 0 && code === 'EADDRINUSE' && tries < FREE_PORT_TRIES) {
        continue;
      }

      throw buildBindError(error, name, { local: port, remote: forward.remote });
    }
  }
}

interface TunnelTarget {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly name: string;
  readonly port: number;
  readonly connect: ForwardTunnelOptions['connect'];
}

interface TunnelNotices {
  readonly writeNotice: (text: string) => void;

  // impd did not answer the WebSocket
  readonly writeUnreachable: () => void;
  readonly onWindowFull: (unackedBytes: number) => void;
}

// One local TCP connection over the client's forward tunnel. The socket
// stays paused until impd answers `opened`, and pauses again while the
// tunnel has no room. Returns a stop.
function openTunnel(socket: Socket, target: TunnelTarget, notices: TunnelNotices): () => void {
  const label = `${target.name}:${String(target.port)}`;

  const stopSocket = (end: ForwardTunnelEnd): void => {
    match(end)
      .with({ kind: 'done' }, () => {
        socket.end();
      })
      .with({ kind: 'unreachable' }, () => {
        notices.writeUnreachable();
        socket.destroy();
      })
      .with({ kind: 'failed' }, (failed) => {
        notices.writeNotice(`${label}: ${failed.code ?? 'error'}: ${failed.message}`);
        socket.destroy();
      })
      .with({ kind: 'closed' }, (closed) => {
        notices.writeNotice(`${label}: ${formatTunnelClose(closed.code)}`);
        socket.destroy();
      })
      .exhaustive();
  };

  const tunnel = openForwardTunnel({
    ...target,
    onOpened: () => {
      socket.resume();
    },
    onData: (data) =>
      new Promise<void>((resolve) => {
        socket.write(data, () => {
          resolve();
        });
      }),
    onEof: () => {
      socket.end();
    },
    onEnd: stopSocket,
  });

  const waitAndResume = async (): Promise<void> => {
    await tunnel.waitForRoom();

    socket.resume();
  };

  socket.on('data', (chunk: Buffer) => {
    if (!tunnel.send(chunk)) {
      socket.pause();
      notices.onWindowFull(tunnel.countUnackedBytes());
      void waitAndResume();
    }
  });

  // a TCP half-close, after every byte before it: the reply may still come
  // back
  socket.on('end', () => {
    tunnel.sendEof();
  });

  // 'close' follows an error, and ends the tunnel
  socket.on('error', () => {});

  socket.on('close', () => {
    tunnel.close();
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
  const now = io.now ?? Date.now;

  // a first failure always prints, however the clock reads
  const state = { ready: false, unreachableAt: Number.NEGATIVE_INFINITY };

  const notices: TunnelNotices = {
    writeNotice: io.writeNotice,
    onWindowFull: io.onWindowFull ?? (() => {}),
    writeUnreachable: () => {
      const failedAt = now();

      if (failedAt - state.unreachableAt > UNREACHABLE_QUIET_MS) {
        io.writeNotice(`could not reach impd at ${config.url}`);
      }

      state.unreachableAt = failedAt;
    },
  };

  const target = {
    baseUrl: config.url,
    token: config.token,
    name,
    connect: io.connect ?? openBunWebSocket,
  };

  const handleConnection = (socket: Socket, remote: number): void => {
    // a connection before the imp check passed
    if (!state.ready) {
      socket.destroy();

      return;
    }

    const stopTunnel = openTunnel(socket, { ...target, port: remote }, notices);

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

    await checkImpExists(config, name);
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

  // `--reverse` specs: GUEST:LOCAL
  readonly reverse: readonly string[];
}

interface RunningProxy {
  readonly stop: () => void;

  // settles when a reverse forward fails for good
  readonly failed: Promise<Error>;
}

// Local forwards first, so a busy port fails before anything listens in the
// imp; then each reverse forward, which wakes the imp.
async function startForwards(
  config: CliConfig,
  options: ProxyOptions,
  io: ProxyIo,
): Promise<RunningProxy> {
  const forwards = options.specs.map((spec) => parseForward(spec));
  const reverse = options.reverse.map((spec) => parseReverse(spec));

  if (forwards.length === 0 && reverse.length === 0) {
    throw new UsageError('name a port to forward, or a --reverse forward');
  }

  const stops: (() => void)[] = [];
  const failures: Promise<Error>[] = [];

  const stop = (): void => {
    for (const stopOne of stops) {
      stopOne();
    }
  };

  try {
    if (forwards.length > 0) {
      const proxy = await startProxy(config, options.name, forwards, io);

      stops.push(proxy.stop);

      for (const [index, forward] of forwards.entries()) {
        console.log(
          `forwarding localhost:${String(proxy.ports[index])} -> ${options.name}:${String(forward.remote)}`,
        );
      }
    }

    for (const spec of reverse) {
      const forwarding = await startReverseForward(config, options.name, spec, io.reverse);

      stops.push(forwarding.stop);
      failures.push(forwarding.failed);

      console.log(
        `forwarding ${options.name}:${formatGuest(forwarding.listening)} -> ${formatLocal(spec.local)}`,
      );
    }
  } catch (error) {
    stop();
    throw error;
  }

  // never settles without a reverse forward
  const failed = failures.length === 0 ? new Promise<Error>(() => {}) : Promise.race(failures);

  return { stop, failed };
}

// `impz proxy`: runs until SIGINT or SIGTERM, then exits 0, or until a reverse
// forward fails for good
export async function runProxy(options: ProxyOptions, io: ProxyIo = PROCESS_IO): Promise<void> {
  let config: CliConfig | null = null;
  let proxy: RunningProxy;

  try {
    config = loadCliConfig(process.env, options.host);

    proxy = await startForwards(config, options, io);
  } catch (error) {
    printError(error, config);

    return;
  }

  const stopped = Promise.withResolvers<Error | null>();

  const handleSignal = (): void => {
    stopped.resolve(null);
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  const failure = await Promise.race([stopped.promise, proxy.failed]);

  process.off('SIGINT', handleSignal);
  process.off('SIGTERM', handleSignal);
  proxy.stop();

  if (failure !== null) {
    printError(failure, config);
  }
}
