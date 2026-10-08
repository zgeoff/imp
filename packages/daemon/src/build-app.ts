import {
  EXEC_CLOSE_RESTARTING,
  EXEC_PATH,
  EXEC_TICKET_PARAM,
  IMAGE_BUILD_PATH,
  TUNNEL_CLOSE_RESTARTING,
  TUNNEL_PATH,
} from '@imp/api';
import { ORPCError, onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { StrictGetMethodPlugin } from '@orpc/server/plugins';
import type { ExecSocket } from '@zgeoff/imp-client';
import { Elysia } from 'elysia';
import * as z from 'zod';
import type { ListenSpec } from './agent-client/listener-stream';
import { MOVING_RETRY_AFTER_S, buildForbiddenError } from './api-errors';
import { withAuditedOpen } from './audit/api-audit';
import { resolveCaller } from './auth/authenticate';
import type { CallerSources } from './auth/authenticate';
import { formatCaller, isCallerAllowed } from './auth/caller';
import type { Caller } from './auth/caller';
import { createLogouts } from './auth/logouts';
import type { Revocations } from './auth/revocations';
import { createSessionRoutes } from './auth/session-routes';
import { readBearer } from './auth/token-store';
import { buildRouter, toApiImage } from './build-router';
import type { RouterDeps } from './build-router';
import { DASHBOARD_PATH, createDashboardFiles } from './dashboard/dashboard-files';
import { buildAuditedBackend } from './exec/audited-backend';
import { buildGrantedBackend } from './exec/exec-grant';
import type { ExecGrant } from './exec/exec-grant';
import { createExecSession } from './exec/exec-session';
import type { ExecSession } from './exec/exec-session';
import { createExecTickets, isCallerLive } from './exec/exec-tickets';
import { createInProcessSocket } from './exec/in-process-socket';
import type { BuildContextRoute } from './images/build-context-route';
import { MCP_PATH, createMcpEndpoint } from './mcp/mcp-endpoint';
import type { MoveService } from './moves/move-service';
import { PROTECTED_RESOURCE_PATH } from './oauth/oauth-metadata';
import { readPeerAddress } from './proxy/forwarded-peers';
import type { ForwardedPeers } from './proxy/forwarded-peers';
import { createReverseForwards } from './reverse/reverse-forwards';
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

  // `POST /images/build`: a build context streamed from the client
  readonly buildContexts: BuildContextRoute;

  // `POST /move/*`: another host's side of a move (docs/architecture/moves.md)
  readonly moves: MoveService;

  // where an unexpected RPC failure is logged; stderr by default
  readonly logRpcFailure?: (failure: unknown) => void;
}

interface SocketEntry<Session> {
  readonly session: Session;
  readonly close: (code: number, reason: string) => void;
  readonly forget: () => void;
}

// Elysia's server, or none under app.handle in tests
interface PeerServer {
  readonly requestIP: (request: Request) => { readonly address: string } | null;

  // seconds a request may sit idle; 0 never ends it
  readonly timeout: (request: Request, seconds: number) => void;
}

export function buildApp(deps: AppDeps) {
  const execTickets = createExecTickets({
    now: deps.now,
    isLive: (caller) => isCallerLive(deps.tokens, deps.revocations, caller),
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

  const logRpcFailure =
    deps.logRpcFailure ??
    ((failure: unknown) => {
      console.error('impd: rpc failed:', failure);
    });

  // expected errors (NOT_FOUND, INVALID_STATE, …) go to the client; anything
  // else is a bug or a host failure worth a log line
  const handler = new RPCHandler(buildRouter({ ...deps, execTickets }), {
    // a GET is what a link or an <img> on any page can make the browser send
    plugins: [new StrictGetMethodPlugin()],
    interceptors: [
      onError((failure) => {
        if (!(failure instanceof ORPCError)) {
          logRpcFailure(failure);
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
  const reverseForwards = createReverseForwards();

  // each exec socket's grant and each tunnel socket's caller, by its
  // upgrade request
  const grants = new WeakMap<Request, ExecGrant>();
  const tunnelCallers = new WeakMap<Request, Caller>();

  const logouts = createLogouts();

  // what an `/exec` socket may open, audited as the caller it runs as: the
  // bearer token's, or the one that asked for the ticket
  const buildExecBackend = (grant: ExecGrant | undefined) => {
    const actor = grant?.caller ?? { kind: 'token', name: 'unknown' };

    return buildAuditedBackend(
      buildGrantedBackend(deps.imps, grant),
      deps.audit,
      actor,
      deps.imps.events,
      deps.now,
    );
  };

  // what ends when the caller's token or grant goes
  const readRevoked = (caller: Readonly<Caller> | undefined): AbortSignal | null => {
    const signals = [
      deps.revocations.readSignal(caller?.tokenId ?? null),
      deps.revocations.readSignal(caller?.grantId ?? null),
    ].filter((signal) => signal !== null);

    return signals.length === 0 ? null : AbortSignal.any(signals);
  };

  // what ends when the caller's dashboard logs out or its token or grant goes
  const readEnds = (caller: Readonly<Caller>): AbortSignal | null => {
    const signals = [
      caller.kind === 'dashboard' ? logouts.readSignal() : null,
      readRevoked(caller),
    ].filter((signal) => signal !== null);

    return signals.length === 0 ? null : AbortSignal.any(signals);
  };

  // closes a socket when its caller's token or grant is removed; returns the
  // undo
  const handleRevocation = (
    caller: Readonly<Caller> | undefined,
    close: () => void,
  ): (() => void) => {
    const signal = readRevoked(caller);

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

    if (!handled.matched) {
      return new Response('not found', { status: 404 });
    }

    return withRetryAfter(handled.response);
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

  // The public route's /mcp: an access token from an OAuth grant and nothing
  // else, no imp token, cookie or tailnet identity. A browser may call only
  // from the route's own origin.
  const publicMcp = createMcpEndpoint({
    findCaller: (request) => {
      const bearer = readBearer(request.headers.get('authorization'));

      return bearer === null ? Promise.resolve(null) : deps.oauth.resolveAccess(bearer);
    },
    handleRpc,
    connectExec: openExecSocket,
    readEnds,
    isCrossOrigin: (request) => isPublicCrossOrigin(request, deps.oauth.issuer),
    challenge: `Bearer resource_metadata="${deps.oauth.issuer}${PROTECTED_RESOURCE_PATH}/mcp", scope="read"`,
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

    // the context streams for as long as it takes: no idle timeout, and Bun's
    // body limit is set to fit it where impd listens. The same callers as
    // /rpc, with the access and audit of `images.build`.
    .post(
      IMAGE_BUILD_PATH,
      async (context) => {
        const caller = await findCaller(context.request, context.server, true);

        if (caller === null) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        context.server?.timeout(context.request, 0);

        return deps.buildContexts.handle(context.request, caller, toApiImage);
      },
      { parse: 'none' },
    )

    // A move ticket in the Authorization header, from a tailnet address on
    // the connected socket, never one a proxy forwarded. A stream runs for as
    // long as the disk takes, so no idle timeout ends it.
    .post(
      '/move/:step',
      (context) => {
        context.server?.timeout(context.request, 0);
        const peer = context.server?.requestIP(context.request)?.address ?? null;

        return deps.moves.handle(context.request, peer);
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

            // Bun answers 0 for a message it dropped
            sendBinary: (data) => ws.raw.send(data) !== 0,
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

            // audited as it opens, with where it listens: `reverse:/tmp/a.sock`
            openListener: (name, spec) => {
              const where = 'port' in spec ? String(spec.port) : readListenPath(spec);

              return withAuditedOpen(
                deps.audit,
                {
                  procedure: `reverse:${where}`,
                  actor: caller ?? { kind: 'token', name: 'unknown' },
                  impName: name,
                  startedAt: deps.now(),
                },
                () => deps.imps.openListener(name, spec, null),
              );
            },
            openAccept: (name, listener, connection) =>
              deps.imps.openAccept(name, listener, connection, 'tunnel'),
            owner:
              caller === undefined ? '' : `${caller.kind}:${caller.name}:${caller.tokenId ?? ''}`,
          },
          tunnelLimits,
          reverseForwards,
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
    publicMcp,

    // the client can tell impd went away on purpose
    closeExecSessions: () => {
      deps.imps.endLogFollows();

      for (const entry of sessions.values()) {
        entry.close(EXEC_CLOSE_RESTARTING, 'impd is restarting');
      }

      for (const entry of tunnels.values()) {
        entry.close(TUNNEL_CLOSE_RESTARTING, 'impd is restarting');
      }
    },
  };
}

// A browser names the page a request comes from in Sec-Fetch-Site or
// Origin; on the public route only the route's own origin may call
function isPublicCrossOrigin(request: Request, origin: string): boolean {
  const site = request.headers.get('sec-fetch-site');
  const from = request.headers.get('origin');

  if (site === null && from === null) {
    return false;
  }

  return from !== origin || (site !== null && site !== 'same-origin');
}

// a reverse forward's socket path, for its audit row
function readListenPath(spec: ListenSpec): string {
  return spec.network === 'unix' ? (spec.path ?? 'auto') : spec.network;
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

const MovingBodySchema = z.object({ json: z.object({ code: z.literal('MOVING') }) });

// A MOVING error says when to ask again in its data and, for a client that
// reads only HTTP, in Retry-After
async function withRetryAfter(response: Response): Promise<Response> {
  if (response.status !== 409) {
    return response;
  }

  try {
    const body: unknown = await response.clone().json();

    if (!MovingBodySchema.safeParse(body).success) {
      return response;
    }
  } catch {
    return response;
  }

  const headers = new Headers(response.headers);

  headers.set('retry-after', String(MOVING_RETRY_AFTER_S));

  return new Response(response.body, { status: response.status, headers });
}
