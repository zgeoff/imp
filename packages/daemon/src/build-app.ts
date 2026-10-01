import { RPCHandler } from '@orpc/server/fetch';
import { Elysia } from 'elysia';
import { buildRouter } from './build-router';
import type { RouterDeps } from './build-router';
import { isAuthorized } from './token';

export interface AppDeps extends RouterDeps {
  readonly token: string;
}

export function buildApp(deps: AppDeps) {
  const handler = new RPCHandler(buildRouter(deps));

  return (
    new Elysia()
      .get('/health', () => ({ status: 'ok' }))

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
  );
}
