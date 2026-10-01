import type { ImpContract } from '@imp/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { loadCliConfig } from './cli-config';

export type ImpClient = ContractRouterClient<ImpContract>;

export function createImpClient(): ImpClient {
  const config = loadCliConfig(process.env);

  const link = new RPCLink({
    url: new URL('/rpc', config.url).href,
    headers: config.token === null ? {} : { authorization: `Bearer ${config.token}` },
  });

  return createORPCClient(link);
}
