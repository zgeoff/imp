import { createImpClient as createClient } from '@impz/client';
import type { ImpClient } from '@impz/client';
import type { CliConfig } from './cli-config';

export type { ImpClient } from '@impz/client';

export function createImpClient(config: Pick<CliConfig, 'url' | 'token'>): ImpClient {
  return createClient({ url: config.url, ...(config.token !== null && { token: config.token }) });
}
