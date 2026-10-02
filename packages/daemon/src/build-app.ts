import { EXEC_PATH } from '@imp/api';
import { ORPCError, onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { Elysia } from 'elysia';
import { buildRouter } from './build-router';
import type { RouterDeps } from './build-router';
import { createExecSession } from './exec/exec-session';
import type { ExecSession } from './exec/exec-session';
import { isAuthorized } from './token';

export interface AppDeps extends RouterDeps {
  readonly token: string;

  // false until the default image is seeded; /health reports it
  readonly isReady: () => boolean;
}

export function buildApp(deps: AppDeps) {
  // expected errors (NOT_FOUND, INVALID_STATE, …) go to the client; anything
  // else is a bug or a host failure worth a log line
  const handler = new RPCHandler(buildRouter(deps), {
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

  // the CLI sends a bearer header; a browser WebSocket can only use ?token=
  const isRequestAuthorized = (header: string | null, url: string): boolean => {
    const queryToken = new URL(url).searchParams.get('token');

    return (
      isAuthorized(header, deps.token) ||
      (queryToken !== null && isAuthorized(`Bearer ${queryToken}`, deps.token))
    );
  };

  const app = new Elysia()
    .get('/health', () => ({ status: 'ok', ready: deps.isReady() }))

    // parse: 'none' leaves the body unread for oRPC
    .all(
      '/rpc*',
      async (context) => {
        if (
          !isRequestAuthorized(context.request.headers.get('authorization'), context.request.url)
        ) {
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
        if (
          !isRequestAuthorized(context.request.headers.get('authorization'), context.request.url)
        ) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        // Elysia ends the upgrade on any returned value, null included
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
          deps.imps,
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

    // 1012 (service restart): the client can tell impd went away on purpose
    closeExecSessions: () => {
      for (const entry of sessions.values()) {
        entry.close(1012, 'impd is restarting');
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
