import {
  EXEC_CLOSE_RESTARTING,
  EXEC_PATH,
  EXEC_TICKET_PARAM,
  TUNNEL_CLOSE_RESTARTING,
  TUNNEL_PATH,
} from '@imp/api';
import { ORPCError, onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { StrictGetMethodPlugin } from '@orpc/server/plugins';
import type { ExecSocket } from '@zgeoff/imp-client';
import { Elysia } from 'elysia';
import { buildForbiddenError } from './api-errors';
import { withAuditedOpen } from './audit/api-audit';
import { resolveCaller } from './auth/authenticate';
import type { CallerSources } from './auth/authenticate';
import { formatCaller, isCallerAllowed } from './auth/caller';
import type { Caller } from './auth/caller';
import { createLogouts } from './auth/logouts';
import type { Revocations } from './auth/revocations';
import { createSessionRoutes } from './auth/session-routes';
import { buildRouter } from './build-router';
import type { RouterDeps } from './build-router';
import { DASHBOARD_PATH, createDashboardFiles } from './dashboard/dashboard-files';
import { buildAuditedBackend } from './exec/audited-backend';
import { buildGrantedBackend } from './exec/exec-grant';
import type { ExecGrant } from './exec/exec-grant';
import { createExecSession } from './exec/exec-session';
import type { ExecSession } from './exec/exec-session';
import { createExecTickets } from './exec/exec-tickets';
import { createInProcessSocket } from './exec/in-process-socket';
import { MCP_PATH, createMcpEndpoint } from './mcp/mcp-endpoint';
import { readPeerAddress } from './proxy/forwarded-peers';
import type { ForwardedPeers } from './proxy/forwarded-peers';
import { createTunnelLimits, createTunnelSession } from './tunnel/tunnel-session';
import type { TunnelSession } from './tunnel/tunnel-session';

// Bun pings an idle exec socket and closes it when no answer comes, so a
// client that vanished without a close (a laptop lid, dropped Wi-Fi) lets
// go of its session, and of the imp's idle timer, within a minute
const EXEC_SOCKET_OPTIONS = { idleTimeout: 30, sendPings: true } as const;

// a socket whose token is removed closes with this: policy violation
const CLOSE_REVOKED = 1008;

// `now` is the clock exec tickets and sessions expire by
export interface AppDeps extends Omit<RouterDeps, 'execTickets'> {
  // the token in <dataDir>/token, which keys the dashboard's sessions
  readonly rootToken: string;
  readonly tailnet: CallerSources['tailnet'];
  readonly revocations: Revocations;

  // client addresses the wake proxy hands over for requests it forwards
  readonly peers: ForwardedPeers;

  // false until the default image is seeded; /health reports it
  readonly isReady: () => boolean;
}

interface SocketEntry<Session> {
  readonly session: Session;
  readonly close: (code: number, reason: string) => void;
  readonly forget: () => void;
}

// Elysia's server, or none under app.handle in tests
interface PeerServer {
  readonly requestIP: (request: Request) => { readonly address: string } | null;
}

export function buildApp(deps: AppDeps) {
  const execTickets = createExecTickets({
    now: deps.now,
    isLive: (caller) => caller.tokenId === null || deps.tokens.findById(caller.tokenId) !== null,
  });

  const sources: CallerSources = {
    tokens: deps.tokens,
    rootToken: deps.rootToken,
    now: deps.now,
    tailnet: deps.tailnet,
  };

  const findCaller = (request: Request, server: PeerServer | null, cookie: boolean) => {
    const socket = server?.requestIP(request)?.address ?? null;
    const peer = readPeerAddress(request, socket, deps.peers);

    return resolveCaller(request, sources, { peer, cookie });
  };

  // expected errors (NOT_FOUND, INVALID_STATE, …) go to the client; anything
  // else is a bug or a host failure worth a log line
  const handler = new RPCHandler(buildRouter({ ...deps, execTickets }), {
    // a GET is what a link or an <img> on any page can make the browser send
    plugins: [new StrictGetMethodPlugin()],
    interceptors: [
      onError((failure) => {
        if (!(failure instanceof ORPCError)) {
          console.error('impd: rpc failed:', failure);
        }
      }),
    ],
  });

  // per exec WebSocket: its session, a close for impd's stop, and the undo
  // of its close on a removed token
  const sessions = new Map<string, SocketEntry<ExecSession>>();

  // per tunnel WebSocket: the same, with its tunnel session
  const tunnels = new Map<string, SocketEntry<TunnelSession>>();

  const tunnelLimits = createTunnelLimits();

  // each exec socket's grant and each tunnel socket's caller, by its
  // upgrade request
  const grants = new WeakMap<Request, ExecGrant>();
  const tunnelCallers = new WeakMap<Request, Caller>();

  const logouts = createLogouts();

  // what an `/exec` socket may open, audited as the caller it runs as: the
  // bearer token's, or the one that asked for the ticket
  const buildExecBackend = (grant: ExecGrant | undefined) => {
    const actor = grant?.caller ?? { kind: 'token', name: 'unknown' };

    return buildAuditedBackend(buildGrantedBackend(deps.imps, grant), deps.audit, actor, deps.now);
  };

  // what ends when the caller's dashboard logs out or its token goes
  const readEnds = (caller: Readonly<Caller>): AbortSignal | null => {
    const signals = [
      caller.kind === 'dashboard' ? logouts.readSignal() : null,
      deps.revocations.readSignal(caller.tokenId),
    ].filter((signal) => signal !== null);

    return signals.length === 0 ? null : AbortSignal.any(signals);
  };

  // closes a socket when its caller's token is removed; returns the undo
  const handleRevocation = (
    caller: Readonly<Caller> | undefined,
    close: () => void,
  ): (() => void) => {
    const signal = deps.revocations.readSignal(caller?.tokenId ?? null);

    // removed between the upgrade and the open
    if (signal?.aborted === true) {
      close();
    }

    signal?.addEventListener('abort', close);

    return () => signal?.removeEventListener('abort', close);
  };

  // a call as `caller`, through the same access rules and audit as /rpc
  const handleRpc = async (request: Request, caller: Readonly<Caller>): Promise<Response> => {
    const handled = await handler.handle(request, {
      prefix: '/rpc',
      context: { caller, ends: readEnds(caller) },
    });

    return handled.matched ? handled.response : new Response('not found', { status: 404 });
  };

  // an `/exec` socket in process, for the MCP endpoint's execs: its ticket
  // opens it as the caller that asked for it, as over the socket route
  const openExecSocket = (url: string): ExecSocket => {
    const ticket = new URL(url).searchParams.get(EXEC_TICKET_PARAM);

    const holder = ticket === null ? null : execTickets.redeem(ticket);
    const id = `in-process-${crypto.randomUUID()}`;

    return createInProcessSocket((peer) => {
      if (holder === null) {
        return null;
      }

      const grant = { caller: holder.caller, name: holder.name };
      const session = createExecSession(peer, buildExecBackend(grant));

      const forget = handleRevocation(grant.caller, () => {
        peer.close(CLOSE_REVOKED, 'the token was removed');
      });

      sessions.set(id, { session, close: peer.close, forget });

      return {
        handleMessage: session.handleMessage,
        handleClose: () => {
          session.handleClose();

          forget();

          sessions.delete(id);
        },
      };
    });
  };

  // the server each MCP request came in on, for its peer's address
  const mcpServers = new WeakMap<Request, PeerServer | null>();

  const mcp = createMcpEndpoint({
    findCaller: (request) => findCaller(request, mcpServers.get(request) ?? null, false),
    handleRpc,
    connectExec: openExecSocket,
    readEnds,
  });

  const sessionRoutes = createSessionRoutes({
    tokens: deps.tokens,
    rootToken: deps.rootToken,
    now: deps.now,
    onLogout: logouts.logOut,
  });

  const dashboard = createDashboardFiles(deps.config.dashboardDir);

  const app = new Elysia({ websocket: EXEC_SOCKET_OPTIONS })
    .get('/health', () => ({ status: 'ok', ready: deps.isReady() }))
    .post('/auth/login', (context) => sessionRoutes.login(context.request), { parse: 'none' })
    .post('/auth/logout', (context) => sessionRoutes.logout(context.request), { parse: 'none' })

    // parse: 'none' leaves the body unread for oRPC
    .all(
      '/rpc*',
      async (context) => {
        const caller = await findCaller(context.request, context.server, true);

        if (caller === null) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        return handleRpc(context.request, caller);
      },
      { parse: 'none' },
    )

    // MCP over streamable HTTP: a token or a tailnet identity, never the
    // cookie. A tool call can run for minutes, so no idle timeout ends it.
    .all(
      MCP_PATH,
      (context) => {
        context.server?.timeout(context.request, 0);
        mcpServers.set(context.request, context.server);

        return mcp.handle(context.request);
      },
      { parse: 'none' },
    )

    // JSON text frames and channel-tagged binary frames (exec-protocol). A
    // ticket, a token or a tailnet identity, never the session cookie: the
    // dashboard gets tickets over /rpc. Each start checks the scope.
    .ws(EXEC_PATH, {
      beforeHandle: async (context) => {
        const ticket = new URL(context.request.url).searchParams.get(EXEC_TICKET_PARAM);

        if (ticket !== null) {
          const holder = execTickets.redeem(ticket);

          if (holder === null) {
            return Response.json({ error: 'unauthorized' }, { status: 401 });
          }

          grants.set(context.request, { caller: holder.caller, name: holder.name });

          // Elysia ends the upgrade on any returned value, null included
          // oxlint-disable-next-line unicorn/no-useless-undefined
          return undefined;
        }

        const caller = await findCaller(context.request, context.server, false);

        if (caller === null) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        grants.set(context.request, { caller, name: null });

        // oxlint-disable-next-line unicorn/no-useless-undefined
        return undefined;
      },
      open: (ws) => {
        const grant = grants.get(ws.data.request);

        const session = createExecSession(
          {
            sendText: (text) => {
              ws.raw.send(text);
            },
            sendBinary: (data) => {
              ws.raw.send(data);
            },
            close: (code, reason) => {
              ws.raw.close(code, reason);
            },
            readBufferedAmount: () => readBufferedAmount(ws.raw),
          },
          buildExecBackend(grant),
        );

        const forget = handleRevocation(grant?.caller, () => {
          ws.raw.close(CLOSE_REVOKED, 'the token was removed');
        });

        sessions.set(ws.id, {
          session,
          close: (code, reason) => {
            ws.raw.close(code, reason);
          },
          forget,
        });
      },
      message: (ws, message) => {
        sessions.get(ws.id)?.session.handleMessage(message);
      },
      drain: (ws) => {
        sessions.get(ws.id)?.session.handleDrain();
      },
      close: (ws) => {
        const entry = sessions.get(ws.id);

        entry?.session.handleClose();
        entry?.forget();
        sessions.delete(ws.id);
      },
    })

    // `imp proxy`: a token or a tailnet identity. Never a ticket, which
    // redeems once: a listener opens a tunnel per connection for hours.
    // Each tunnel checks the caller's scope.
    .ws(TUNNEL_PATH, {
      beforeHandle: async (context) => {
        const caller = await findCaller(context.request, context.server, false);

        if (caller === null) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        tunnelCallers.set(context.request, caller);

        // oxlint-disable-next-line unicorn/no-useless-undefined
        return undefined;
      },
      open: (ws) => {
        const caller = tunnelCallers.get(ws.data.request);

        const peer = {
          close: (code: number, reason: string): void => {
            ws.raw.close(code, reason);
          },
        };

        const session = createTunnelSession(
          {
            sendText: (text) => {
              ws.raw.send(text);
            },
            sendBinary: (data) => {
              ws.raw.send(data);
            },
            close: peer.close,
          },
          {
            findImpId: async (name) => {
              if (caller === undefined || !isCallerAllowed(caller, 'exec', name)) {
                const who = caller === undefined ? 'nobody' : formatCaller(caller);

                throw buildForbiddenError(`${who} may not open a tunnel into imp ${name}`);
              }

              const imp = await deps.imps.getImp(name);

              return imp.id;
            },

            // audited as it opens, with the guest port: `tunnel:5432`
            openDial: (name, target) => {
              const port = target.address.split(':').at(-1) ?? '';

              return withAuditedOpen(
                deps.audit,
                {
                  procedure: `tunnel:${port}`,
                  actor: caller ?? { kind: 'token', name: 'unknown' },
                  impName: name,
                  startedAt: deps.now(),
                },
                () => deps.imps.openDial(name, target, 'tunnel'),
              );
            },
          },
          tunnelLimits,
        );

        const forget = handleRevocation(caller, () => {
          peer.close(CLOSE_REVOKED, 'the token was removed');
        });

        tunnels.set(ws.id, { session, close: peer.close, forget });
      },
      message: (ws, message) => {
        tunnels.get(ws.id)?.session.handleMessage(message);
      },
      close: (ws) => {
        const entry = tunnels.get(ws.id);

        entry?.session.handleClose();
        entry?.forget();
        tunnels.delete(ws.id);
      },
    })

    // under its own prefix, so no dashboard route can shadow the API's
    .get('/', () => Response.redirect(DASHBOARD_PATH, 302))
    .get(DASHBOARD_PATH, (context) => dashboard.serve(context.request))
    .get(`${DASHBOARD_PATH}*`, (context) => dashboard.serve(context.request));

  return {
    app,

    // the client can tell impd went away on purpose
    closeExecSessions: () => {
      for (const entry of sessions.values()) {
        entry.close(EXEC_CLOSE_RESTARTING, 'impd is restarting');
      }

      for (const entry of tunnels.values()) {
        entry.close(TUNNEL_CLOSE_RESTARTING, 'impd is restarting');
      }
    },
  };
}

// Bun's ServerWebSocket has getBufferedAmount; Elysia's type leaves it out
function readBufferedAmount(socket: object): number {
  const read: unknown = Reflect.get(socket, 'getBufferedAmount');

  if (typeof read !== 'function') {
    return 0;
  }

  const amount: unknown = Reflect.apply(read, socket, []);

  return typeof amount === 'number' ? amount : 0;
}
