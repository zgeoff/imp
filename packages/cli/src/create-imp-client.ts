import type { ImpContract } from '@imp/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { loadCliConfig } from './cli-config';
import { buildImpdUrl } from './impd-url';

export type ImpClient = ContractRouterClient<ImpContract>;

export function createImpClient(): ImpClient {
  const config = loadCliConfig(process.env);

  const link = new RPCLink({
    url: buildImpdUrl(config.url, '/rpc').href,
    headers: config.token === null ? {} : { authorization: `Bearer ${config.token}` },
  });

  return createORPCClient(link);
}
