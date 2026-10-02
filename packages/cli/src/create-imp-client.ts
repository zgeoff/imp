import { createImpClient as createClient } from '@zgeoff/imp-client';
import type { ImpClient } from '@zgeoff/imp-client';
import type { CliConfig } from './cli-config';

export type { ImpClient } from '@zgeoff/imp-client';

export function createImpClient(config: Pick<CliConfig, 'url' | 'token'>): ImpClient {
  return createClient({ url: config.url, ...(config.token !== null && { token: config.token }) });
}
