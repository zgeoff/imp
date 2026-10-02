import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { Server } from 'ssh2';
import type { AuthContext, ClientInfo, Connection } from 'ssh2';
import { isCallerAllowed } from '../auth/caller';
import type { Caller } from '../auth/caller';
import type { ImpRecord } from '../db/imps';
import { createAgentForwarding } from './agent-forwarding';
import { formatFailure } from './channel-io';
import { handleForward, resolveSocketTarget, resolveTcpTarget } from './forward-channel';
import type { LoginKeys } from './login-keys';
import { createRemoteForwarding } from './remote-forwarding';
import type { RemoteForwardRequest } from './remote-forwarding';
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
  readonly keys: LoginKeys;
  readonly backend: SshBackend;

  // aborts when the token or key with this id is removed; null for none
  readonly readRevocation: (id: string | null) => AbortSignal | null;
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

// a full login with its imp and who it runs as, a key query to accept, or
// a refusal
type LoginOutcome = Login | 'query' | 'rejected';

interface Login {
  readonly imp: ImpRecord;
  readonly caller: Caller;

  // the bound key's id; null for a key in authorized_keys
  readonly keyId: string | null;
}

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
  const login: { granted: Login | null; failures: number } = { granted: null, failures: 0 };

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

    // ssh2 emits `ready` inside accept, so the login is set first
    if (outcome !== 'query') {
      login.granted = outcome;
    }

    ctx.accept();
  };

  client.on('authentication', (ctx) => {
    void handleAuthentication(ctx);
  });

  client.on('ready', () => {
    const granted = login.granted;

    if (granted === null) {
      client.end();

      return;
    }

    onAuthenticated();

    deps.log(`impd: ssh: ${granted.imp.name}: login from ${info.ip} as ${granted.caller.name}`);

    handleLogin(client, granted, buildSshEnv(info, socket), deps);
  });
}

// An unknown user, an unknown key and a key without `exec` on the imp get
// one answer, so nobody can probe for imp names; a key query, whatever its
// scope, is answered from the key alone. Nothing here wakes the imp.
async function checkLogin(ctx: AuthContext, deps: SshGatewayDeps): Promise<LoginOutcome> {
  if (ctx.method !== 'publickey') {
    return 'rejected';
  }

  const found = deps.keys.findKey(ctx.key.data);

  if (found === null) {
    return 'rejected';
  }

  if (ctx.signature === undefined || ctx.blob === undefined) {
    return 'query';
  }

  if (!found.key.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) {
    return 'rejected';
  }

  // Checked once, for the whole connection: every channel runs on this imp.
  // That holds only because a token never changes (token-store.test.ts).
  // Before the lookup, so the time taken shows nothing of which imps exist.
  if (!isCallerAllowed(found.caller, 'exec', ctx.username)) {
    return 'rejected';
  }

  const imp = await deps.backend.findImp(ctx.username);

  if (imp === undefined || !isCallerAllowed(found.caller, 'exec', imp.name)) {
    return 'rejected';
  }

  return { imp, caller: found.caller, keyId: found.keyId };
}

// An authenticated connection counts as activity until it closes. It starts
// the imp's wake at once, while the client still opens its channels.
function handleLogin(
  client: Connection,
  granted: Login,
  sshEnv: readonly string[],
  deps: SshGatewayDeps,
): void {
  const imp = granted.imp;
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

  const remote = createRemoteForwarding({
    client,
    impName: imp.name,
    backend,
    awake,
    log: deps.log,
  });

  const context: SshConnectionContext = {
    impName: imp.name,
    actor: { kind: granted.caller.kind, name: granted.caller.name },
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

  const stopWatching = handleRevocations(client, [granted.caller.tokenId, granted.keyId], deps);

  client.on('close', () => {
    release();
    stopWatching();

    agent.stop();
    remote.stop();
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

  // Remote forwards (`ssh -R`) listen in the guest, on its loopback. ssh2
  // types this event for TCP; a unix socket request carries socketPath.
  client.on('request', (accept, reject, name, info) => {
    const request = readForwardRequest(name, info);

    if (readIsCancel(name)) {
      remote.cancel(request, accept, reject);
    } else {
      void remote.open(request, accept, reject);
    }
  });
}

// a global request as a remote forward: ssh2 passes either kind's fields
function readForwardRequest(name: string, info: object): RemoteForwardRequest {
  if (name.includes('streamlocal')) {
    const socketPath: unknown = Reflect.get(info, 'socketPath');

    return { kind: 'unix', socketPath: typeof socketPath === 'string' ? socketPath : '' };
  }

  const bindAddr: unknown = Reflect.get(info, 'bindAddr');
  const bindPort: unknown = Reflect.get(info, 'bindPort');

  return {
    kind: 'tcp',
    bindAddr: typeof bindAddr === 'string' ? bindAddr : '',
    bindPort: typeof bindPort === 'number' ? bindPort : -1,
  };
}

function readIsCancel(name: string): boolean {
  return name.startsWith('cancel-');
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

// Removing the token or the key behind a login ends the connection. One that
// logged in just before the removal gets a signal that is aborted already.
function handleRevocations(
  client: Connection,
  ids: readonly (string | null)[],
  deps: SshGatewayDeps,
): () => void {
  const signals = ids.map((id) => deps.readRevocation(id)).filter((signal) => signal !== null);

  const stopClient = (): void => {
    client.end();
  };

  for (const signal of signals) {
    if (signal.aborted) {
      stopClient();
    } else {
      signal.addEventListener('abort', stopClient, { once: true });
    }
  }

  return () => {
    for (const signal of signals) {
      signal.removeEventListener('abort', stopClient);
    }
  };
}
