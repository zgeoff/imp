import type { Imp, ImpContract } from '@imp/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { checkServer } from './check-server';
import type { ServerCheck } from './check-server';
import { requireAwake } from './require-awake';
import type { RequireAwakeOptions } from './require-awake';
import { resolveImpdUrl } from './resolve-impd-url';

type RpcClient = ContractRouterClient<ImpContract>;

export interface ImpClientOptions {
  // impd's API, e.g. http://localhost:7070; a path prefix is kept, so impd
  // can sit behind a reverse proxy at /impd/
  readonly url: string;

  // the bearer token from `<IMP_DATA_DIR>/token`; leave it out when a proxy
  // in front of impd adds it, as a browser app should
  readonly token?: string;

  // swaps the transport, e.g. an in-process app in tests
  readonly fetch?: (request: Request) => Promise<Response>;
}

export interface ImpClient extends RpcClient {
  // one wake or start; see require-awake.ts for the states it refuses
  readonly requireAwake: (name: string, options?: RequireAwakeOptions) => Promise<Imp>;

  // whether impd speaks this client's version of the API
  readonly checkServer: () => Promise<ServerCheck>;
}

export function createImpClient(options: Readonly<ImpClientOptions>): ImpClient {
  const token = options.token;
  const customFetch = options.fetch;

  const link = new RPCLink({
    url: resolveImpdUrl(options.url, '/rpc').href,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    ...(customFetch !== undefined && { fetch: (request: Request) => customFetch(request) }),
  });

  const rpc: RpcClient = createORPCClient(link);

  // the oRPC client is a proxy, so its namespaces are copied one by one;
  // `satisfies` fails the build when the contract grows a namespace
  const namespaces = {
    imps: rpc.imps,
    checkpoints: rpc.checkpoints,
    images: rpc.images,
    exec: rpc.exec,
    system: rpc.system,
  } satisfies RpcClient;

  return {
    ...namespaces,
    requireAwake: (name, awakeOptions) => requireAwake(rpc, name, awakeOptions),
    checkServer: () => checkServer(rpc),
  };
}
