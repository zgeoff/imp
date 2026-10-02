import { EXEC_CLOSE_RESTARTING, EXEC_PATH, EXEC_TICKET_PARAM, TUNNEL_PATH } from '@imp/api';
import { ORPCError, onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { StrictGetMethodPlugin } from '@orpc/server/plugins';
import { Elysia } from 'elysia';
import { isAuthenticated } from './auth/authenticate';
import { createSessionRoutes } from './auth/session-routes';
import { buildRouter } from './build-router';
import type { RouterDeps } from './build-router';
import { DASHBOARD_PATH, createDashboardFiles } from './dashboard/dashboard-files';
import { ANY_IMP_GRANT, buildGrantedBackend } from './exec/exec-grant';
import type { ExecGrant } from './exec/exec-grant';
import { createExecSession } from './exec/exec-session';
import type { ExecSession } from './exec/exec-session';
import { createExecTickets } from './exec/exec-tickets';
import { isAuthorized } from './token';
import { createTunnelLimits, createTunnelSession } from './tunnel/tunnel-session';
import type { TunnelSession } from './tunnel/tunnel-session';

// Bun pings an idle exec socket and closes it when no answer comes, so a
// client that vanished without a close (a laptop lid, dropped Wi-Fi) lets
// go of its session, and of the imp's idle timer, within a minute
const EXEC_SOCKET_OPTIONS = { idleTimeout: 30, sendPings: true } as const;

export interface AppDeps extends Omit<RouterDeps, 'execTickets'> {
  readonly token: string;

  // false until the default image is seeded; /health reports it
  readonly isReady: () => boolean;

  // the clock exec tickets expire by
  readonly now: () => number;
}

export function buildApp(deps: AppDeps) {
  const execTickets = createExecTickets(deps.now);

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

  // per exec WebSocket: its session, and a close for impd's stop
  const sessions = new Map<
    string,
    { readonly session: ExecSession; readonly close: (code: number, reason: string) => void }
  >();

  // per tunnel WebSocket: its session, and a close for impd's stop
  const tunnels = new Map<
    string,
    { readonly session: TunnelSession; readonly close: (code: number, reason: string) => void }
  >();

  const tunnelLimits = createTunnelLimits();

  // each exec socket's grant, by its upgrade request
  const grants = new WeakMap<Request, ExecGrant>();

  const sessionRoutes = createSessionRoutes(deps);
  const dashboard = createDashboardFiles(deps.config.dashboardDir);

  const app = new Elysia({ websocket: EXEC_SOCKET_OPTIONS })
    .get('/health', () => ({ status: 'ok', ready: deps.isReady() }))
    .post('/auth/login', (context) => sessionRoutes.login(context.request), { parse: 'none' })
    .post('/auth/logout', (context) => sessionRoutes.logout(context.request), { parse: 'none' })

    // parse: 'none' leaves the body unread for oRPC
    .all(
      '/rpc*',
      async (context) => {
        if (!isAuthenticated(context.request, deps.token, deps.now())) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        const handled = await handler.handle(context.request, { prefix: '/rpc', context: {} });

        return handled.matched ? handled.response : new Response('not found', { status: 404 });
      },
      { parse: 'none' },
    )

    // text frames are JSON control (Elysia parses them), binary frames are
    // channel-tagged stream data (packages/api exec-protocol). The token or a
    // ticket, never the session cookie: the dashboard gets tickets over /rpc.
    .ws(EXEC_PATH, {
      beforeHandle: (context) => {
        // Elysia ends the upgrade on any returned value, null included
        if (isAuthorized(context.request.headers.get('authorization'), deps.token)) {
          grants.set(context.request, ANY_IMP_GRANT);

          // oxlint-disable-next-line unicorn/no-useless-undefined
          return undefined;
        }

        const ticket = new URL(context.request.url).searchParams.get(EXEC_TICKET_PARAM);

        const name = ticket === null ? null : execTickets.redeem(ticket);

        if (name === null) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        grants.set(context.request, { kind: 'imp', name });

        // oxlint-disable-next-line unicorn/no-useless-undefined
        return undefined;
      },
      open: (ws) => {
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
          buildGrantedBackend(deps.imps, grants.get(ws.data.request)),
        );

        sessions.set(ws.id, {
          session,
          close: (code, reason) => {
            ws.raw.close(code, reason);
          },
        });
      },
      message: (ws, message) => {
        sessions.get(ws.id)?.session.handleMessage(message);
      },
      drain: (ws) => {
        sessions.get(ws.id)?.session.handleDrain();
      },
      close: (ws) => {
        sessions.get(ws.id)?.session.handleClose();
        sessions.delete(ws.id);
      },
    })

    // `imp proxy`: the bearer header only. A ticket lives 30 s and redeems
    // once, which suits a console, not a listener that opens a tunnel per
    // connection for hours.
    .ws(TUNNEL_PATH, {
      beforeHandle: (context) => {
        if (isAuthorized(context.request.headers.get('authorization'), deps.token)) {
          // oxlint-disable-next-line unicorn/no-useless-undefined
          return undefined;
        }

        return Response.json({ error: 'unauthorized' }, { status: 401 });
      },
      open: (ws) => {
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
          { openDial: (name, target) => deps.imps.openDial(name, target, 'tunnel') },
          tunnelLimits,
        );

        tunnels.set(ws.id, { session, close: peer.close });
      },
      message: (ws, message) => {
        tunnels.get(ws.id)?.session.handleMessage(message);
      },
      close: (ws) => {
        tunnels.get(ws.id)?.session.handleClose();
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
      for (const entry of [...sessions.values(), ...tunnels.values()]) {
        entry.close(EXEC_CLOSE_RESTARTING, 'impd is restarting');
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
