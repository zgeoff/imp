// An impd WebSocket endpoint, with the same join as the client's
// resolveImpdUrl: a base path such as https://host/imp stays in front.
export function buildWebSocketUrl(base: string, path: string): string {
  const url = new URL(base);

  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  return url.toString();
}
