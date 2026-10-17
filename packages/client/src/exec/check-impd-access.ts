import { ORPCError } from '@orpc/client';
import type { FeatureSource } from '../require-features';

export type ImpdAccess = 'unauthorized' | 'unreachable' | 'reachable';

const CHECK_TIMEOUT_MS = 5000;

// Why a WebSocket upgrade failed. Bun's client reports no HTTP status for a
// refused upgrade, so this asks `/rpc`, which checks the same token. Any
// answer, even an older impd's NOT_FOUND, is an ORPCError with its status.
export async function checkImpdAccess(rpc: Pick<FeatureSource, 'system'>): Promise<ImpdAccess> {
  try {
    await rpc.system.features(undefined, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });

    return 'reachable';
  } catch (error) {
    if (!(error instanceof ORPCError)) {
      return 'unreachable';
    }

    return error.status === 401 ? 'unauthorized' : 'reachable';
  }
}
