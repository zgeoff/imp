import type { AnyRouter } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { HttpResponse, http } from 'msw';
import type { HttpHandler } from 'msw';

// impd's RPC endpoint at `origin` as an MSW handler: oRPC's own fetch handler
// answers the procedures of `router` (from `implement(impContract)`), and any
// other procedure gets a 404, as an impd without it would answer.
// oxlint-disable-next-line prefer-readonly-parameter-types -- oRPC's routers hold mutable procedures
export function buildStubImpd(origin: string, router: AnyRouter): HttpHandler {
  const rpc = new RPCHandler(router);

  return http.post(`${origin}/rpc/*`, async (info) => {
    const result = await rpc.handle(info.request, { prefix: '/rpc' });

    return result.matched
      ? result.response
      : HttpResponse.text('no such procedure', { status: 404 });
  });
}
