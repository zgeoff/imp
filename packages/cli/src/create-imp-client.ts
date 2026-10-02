import { createImpClient as createClient } from '@zgeoff/imp-client';
import type { ImpClient } from '@zgeoff/imp-client';
import { loadCliConfig } from './cli-config';

export type { ImpClient } from '@zgeoff/imp-client';

export function createImpClient(): ImpClient {
  const config = loadCliConfig(process.env);

  return createClient({ url: config.url, ...(config.token !== null && { token: config.token }) });
}
