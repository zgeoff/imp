import { buildImpdUrl } from './impd-url';

export type ImpdAccess = 'unauthorized' | 'unreachable' | 'reachable';

const CHECK_TIMEOUT_MS = 5000;

// Why a WebSocket upgrade failed. Bun's client reports no HTTP status for a
// refused upgrade, so this asks `/rpc`, which checks the same token.
export async function checkImpdAccess(baseUrl: string, token: string | null): Promise<ImpdAccess> {
  try {
    const response = await fetch(buildImpdUrl(baseUrl, '/rpc/system/info'), {
      method: 'POST',
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });

    await response.body?.cancel();

    return response.status === 401 ? 'unauthorized' : 'reachable';
  } catch {
    return 'unreachable';
  }
}
