// `new URL('/rpc', base)` drops the base's path; impd behind a proxy at
// https://host/impd/ serves its API at https://host/impd/rpc
export function resolveImpdUrl(base: string, path: string): URL {
  const url = new URL(base);

  const prefix = url.pathname.replace(/\/+$/, '');

  url.pathname = `${prefix}${path}`;
  url.search = '';
  url.hash = '';

  return url;
}
