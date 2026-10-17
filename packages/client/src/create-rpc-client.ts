import type { ImpContract } from '@impz/api';
import { ORPCError, createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { resolveImpdUrl } from './resolve-impd-url';

export type RpcClient = ContractRouterClient<ImpContract>;

export interface RpcClientOptions {
  readonly url: string;
  readonly token: string | null;
  readonly fetch?: (request: Request) => Promise<Response>;
}

// A bare client of impd's `/rpc` for an exec session, which has a URL and a
// token but no ImpClient. A proxy's plain-text error rejects as an ORPCError
// with its status too, so any answer reads as an answer.
export function createRpcClient(options: Readonly<RpcClientOptions>): RpcClient {
  const customFetch = options.fetch;

  return createORPCClient(
    new RPCLink({
      url: resolveImpdUrl(options.url, '/rpc').href,
      headers: options.token === null ? {} : { authorization: `Bearer ${options.token}` },
      fetch: async (request, init) => {
        const response = await (customFetch === undefined
          ? fetch(request, init)
          : customFetch(request));

        if (response.ok || isJson(response.headers.get('content-type'))) {
          return response;
        }

        await response.body?.cancel();

        throw new ORPCError('UNEXPECTED_ANSWER', {
          status: response.status,
          message: `impd answered with ${String(response.status)}`,
        });
      },
    }),
  );
}

function isJson(contentType: string | null): boolean {
  return (contentType ?? '').startsWith('application/json');
}
