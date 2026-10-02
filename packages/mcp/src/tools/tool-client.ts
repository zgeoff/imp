import type { ImpClient } from '@zgeoff/imp-client';

// The part of the SDK client the tools call: an ImpClient, or a fake of just
// this in a test
export interface ToolClient {
  readonly imps: Pick<ImpClient['imps'], 'list' | 'create' | 'destroy' | 'sleep' | 'url' | 'fork'>;
  readonly images: Pick<ImpClient['images'], 'list'>;
  readonly checkpoints: Pick<ImpClient['checkpoints'], 'create' | 'list' | 'restore' | 'delete'>;
  readonly openExec: ImpClient['openExec'];
}
