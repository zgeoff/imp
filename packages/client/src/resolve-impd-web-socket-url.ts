import { resolveImpdUrl } from './resolve-impd-url';

// An impd WebSocket endpoint under the base URL: the same join as
// resolveImpdUrl, on ws: or wss:.
export function resolveImpdWebSocketUrl(base: string, path: string): URL {
  const url = resolveImpdUrl(base, path);

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  return url;
}
