import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { Server } from 'ssh2';
import type { AuthContext, ClientInfo, Connection } from 'ssh2';
import type { ImpRecord } from '../db/imps';
import { createAgentForwarding } from './agent-forwarding';
import type { AuthorizedKeys } from './authorized-keys';
import { formatFailure } from './channel-io';
import { handleForward, resolveSocketTarget, resolveTcpTarget } from './forward-channel';
import { handleSession } from './session-channel';
import type { SshBackend, SshConnectionContext } from './ssh-connection-context';

// A client must log in within this time of connecting, or it is dropped.
const AUTH_TIMEOUT_MS = 30_000;

// at most this many connections waiting to log in; more are dropped at once
const MAX_UNAUTHENTICATED = 32;

// rejected signed logins before the connection is dropped (OpenSSH's
// MaxAuthTries is 6)
const MAX_AUTH_FAILURES = 6;

// A client that vanished without a FIN would keep its imp awake for good;
// the keepalive drops it after about 45 s of silence.
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 3;

export interface SshGatewayDeps {
  readonly hostKey: string;
  readonly authorizedKeys: AuthorizedKeys;
  readonly backend: SshBackend;
  readonly log: (message: string) => void;
}

export interface SshGateway {
  readonly port: number;

  // drops every connection and stops listening
  readonly stop: () => Promise<void>;
}

// a connection that has not logged in yet
interface PendingSocket {
  readonly socket: Socket;
  readonly timer: Timer;
}

// a full login with its imp, a key query to accept, or a refusal
type LoginOutcome = ImpRecord | 'query' | 'rejected';

// The SSH gateway: `ssh <imp>@<host>` lands in the imp, waking it if needed.
// impd accepts each TCP connection and hands it to ssh2, so the login limits
// cover the handshake, and SSH_CONNECTION knows the local address.
export async function startSshGateway(
  deps: SshGatewayDeps,
  port: number,
  host: string,
): Promise<SshGateway> {
  const pending = new Map<string, PendingSocket>();
  const clients = new Set<Connection>();

  const ssh = new Server(
    {
      hostKeys: [deps.hostKey],
      ident: 'imp',
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
    },
    (client, info) => {
      const key = buildRemoteKey(info.ip, info.port);
      const entry = pending.get(key);

      if (entry === undefined) {
        client.end();

        return;
      }

      clients.add(client);

      client.on('close', () => {
        clients.delete(client);
      });

      // a client that resets the connection or fails the handshake
      client.on('error', () => {
        client.end();
      });

      handleClient(client, info, entry.socket, deps, () => {
        clearTimeout(entry.timer);

        pending.delete(key);
      });
    },
  );

  const listener = createServer((socket) => {
    if (pending.size >= MAX_UNAUTHENTICATED) {
      socket.destroy();

      return;
    }

    const key = buildRemoteKey(socket.remoteAddress ?? '', socket.remotePort ?? 0);

    const timer = setTimeout(() => {
      socket.destroy();
    }, AUTH_TIMEOUT_MS);

    pending.set(key, { socket, timer });

    socket.once('close', () => {
      clearTimeout(timer);

      pending.delete(key);
    });

    ssh.injectSocket(socket);
  });

  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);

    listener.listen(port, host, () => {
      listener.off('error', reject);

      resolve();
    });
  });

  const address = listener.address();

  return {
    port: typeof address === 'object' && address !== null ? address.port : port,
    stop: async () => {
      const closed = new Promise<void>((resolve) => {
        listener.close(() => {
          resolve();
        });
      });

      for (const client of clients) {
        client.end();
      }

      for (const entry of pending.values()) {
        entry.socket.destroy();
      }

      await closed;
    },
  };
}

function buildRemoteKey(ip: string, port: number): string {
  return `${ip} ${String(port)}`;
}

// Logs a client in and serves its channels.
function handleClient(
  client: Connection,
  info: ClientInfo,
  socket: Socket,
  deps: SshGatewayDeps,
  onAuthenticated: () => void,
): void {
  const login: { imp: ImpRecord | null; failures: number } = { imp: null, failures: 0 };

  const handleAuthentication = async (ctx: AuthContext): Promise<void> => {
    let outcome: LoginOutcome;

    try {
      outcome = await checkLogin(ctx, deps);
    } catch (error) {
      deps.log(`impd: ssh: login check failed: ${formatFailure(error)}`);
      ctx.reject(['publickey']);

      return;
    }

    if (outcome === 'rejected') {
      ctx.reject(['publickey']);

      login.failures += 1;

      if (login.failures >= MAX_AUTH_FAILURES) {
        client.end();
      }

      return;
    }

    // ssh2 emits `ready` inside accept, so the imp is set first
    if (outcome !== 'query') {
      login.imp = outcome;
    }

    ctx.accept();
  };

  client.on('authentication', (ctx) => {
    void handleAuthentication(ctx);
  });

  client.on('ready', () => {
    const imp = login.imp;

    if (imp === null) {
      client.end();

      return;
    }

    onAuthenticated();

    deps.log(`impd: ssh: ${imp.name}: login from ${info.ip}`);

    handleLogin(client, imp, buildSshEnv(info, socket), deps);
  });
}

// An unknown user and an unknown key get the same answer, so nobody can
// probe for imp names. A key query (no signature) is answered from the key
// alone. Nothing here wakes the imp.
async function checkLogin(ctx: AuthContext, deps: SshGatewayDeps): Promise<LoginOutcome> {
  if (ctx.method !== 'publickey') {
    return 'rejected';
  }

  const key = deps.authorizedKeys.find(ctx.key.data);

  if (key === null) {
    return 'rejected';
  }

  if (ctx.signature === undefined || ctx.blob === undefined) {
    return 'query';
  }

  if (!key.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) {
    return 'rejected';
  }

  const imp = await deps.backend.findImp(ctx.username);

  return imp ?? 'rejected';
}

// An authenticated connection counts as activity until it closes. It starts
// the imp's wake at once, while the client still opens its channels.
function handleLogin(
  client: Connection,
  imp: ImpRecord,
  sshEnv: readonly string[],
  deps: SshGatewayDeps,
): void {
  const backend = deps.backend;
  const release = backend.tracker.open(imp.id, 'ssh');

  const wakeImp = async (): Promise<void> => {
    const running = await backend.requireRunning(imp.name);

    if (running.wokeMs !== null) {
      deps.log(`impd: ssh: ${imp.name} woke in ${String(running.wokeMs)}ms`);
    }

    await backend.recordActivity(imp.name);
  };

  const awake = wakeImp();

  // a connection that opens no channel never awaits the wake
  const printWakeFailure = async (): Promise<void> => {
    try {
      await awake;
    } catch (error) {
      deps.log(`impd: ssh: ${imp.name}: could not wake: ${formatFailure(error)}`);
    }
  };

  void printWakeFailure();
  const agent = createAgentForwarding({ client, impName: imp.name, backend, log: deps.log });

  const context: SshConnectionContext = {
    impName: imp.name,
    backend,
    awake,
    sshEnv,
    agent,
    log: deps.log,
  };

  // the idle timeout counts from the end of the connection
  const updateLastActive = async (): Promise<void> => {
    await backend.recordActivity(imp.name).catch(() => null);
  };

  client.on('close', () => {
    release();

    agent.stop();
    void updateLastActive();
  });

  client.on('session', (accept) => {
    handleSession(accept(), context);
  });

  client.on('tcpip', (accept, reject, request) => {
    void handleForward(accept, reject, resolveTcpTarget(request.destIP, request.destPort), context);
  });

  client.on('openssh.streamlocal', (accept, reject, request) => {
    void handleForward(accept, reject, resolveSocketTarget(request.socketPath), context);
  });

  // remote forwards (`ssh -R`) would listen in the host container
  client.on('request', (_accept, reject) => {
    reject?.();
  });
}

// as sshd sets them: the client's address and port, then the server's
function buildSshEnv(info: ClientInfo, socket: Socket): readonly string[] {
  const client = `${info.ip} ${String(info.port)}`;
  const localPort = String(socket.localPort ?? 0);

  return [
    `SSH_CONNECTION=${client} ${socket.localAddress ?? ''} ${localPort}`,
    `SSH_CLIENT=${client} ${localPort}`,
  ];
}
