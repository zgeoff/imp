import { EXEC_CLOSE_RESTARTING, EXEC_PATH, EXEC_TICKET_PARAM } from '@imp/api';
import { ORPCError, onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { Elysia } from 'elysia';
import { buildRouter } from './build-router';
import type { RouterDeps } from './build-router';
import { createExecSession } from './exec/exec-session';
import type { ExecBackend, ExecSession } from './exec/exec-session';
import { createExecTickets } from './exec/exec-tickets';
import { isAuthorized } from './token';

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

  // the imp a ticket-authenticated exec socket may start, by its upgrade
  // request; a bearer-authenticated socket has none and may start any imp
  const ticketNames = new WeakMap<Request, string>();

  const app = new Elysia()
    .get('/health', () => ({ status: 'ok', ready: deps.isReady() }))

    // parse: 'none' leaves the body unread for oRPC
    .all(
      '/rpc*',
      async (context) => {
        if (!isAuthorized(context.request.headers.get('authorization'), deps.token)) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        const handled = await handler.handle(context.request, { prefix: '/rpc', context: {} });

        return handled.matched ? handled.response : new Response('not found', { status: 404 });
      },
      { parse: 'none' },
    )

    // text frames are JSON control (Elysia parses them), binary frames are
    // channel-tagged stream data (packages/api exec-protocol)
    .ws(EXEC_PATH, {
      beforeHandle: (context) => {
        // Elysia ends the upgrade on any returned value, null included
        if (isAuthorized(context.request.headers.get('authorization'), deps.token)) {
          // oxlint-disable-next-line unicorn/no-useless-undefined
          return undefined;
        }

        const ticket = new URL(context.request.url).searchParams.get(EXEC_TICKET_PARAM);

        const name = ticket === null ? null : execTickets.redeem(ticket);

        if (name === null) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        ticketNames.set(context.request, name);

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
          buildTicketBackend(deps.imps, ticketNames.get(ws.data.request)),
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
    });

  return {
    app,

    // the client can tell impd went away on purpose
    closeExecSessions: () => {
      for (const entry of sessions.values()) {
        entry.close(EXEC_CLOSE_RESTARTING, 'impd is restarting');
      }
    },
  };
}

// a ticket only starts the imp it was issued for
function buildTicketBackend(backend: ExecBackend, ticketName: string | undefined): ExecBackend {
  if (ticketName === undefined) {
    return backend;
  }

  return {
    openExec: (name, request) =>
      name === ticketName
        ? backend.openExec(name, request)
        : Promise.reject(
            new ORPCError('FORBIDDEN', { message: `the exec ticket is for imp ${ticketName}` }),
          ),
    recordActivity: (name) => backend.recordActivity(name),
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
