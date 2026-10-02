import { resolveImpdUrl } from '../resolve-impd-url';

export type ImpdAccess = 'unauthorized' | 'unreachable' | 'reachable';

const CHECK_TIMEOUT_MS = 5000;

// Why a WebSocket upgrade failed. Bun's client reports no HTTP status for a
// refused upgrade, so this asks `/rpc`, which checks the same token.
export async function checkImpdAccess(
  baseUrl: string,
  token: string | null,
  customFetch: (request: Request) => Promise<Response> = fetch,
): Promise<ImpdAccess> {
  try {
    const request = new Request(resolveImpdUrl(baseUrl, '/rpc/system/info').href, {
      method: 'POST',
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });

    const response = await customFetch(request);

    await response.body?.cancel();

    return response.status === 401 ? 'unauthorized' : 'reachable';
  } catch {
    return 'unreachable';
  }
}
