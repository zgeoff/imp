// An impd endpoint under the IMP_URL base. `new URL('/rpc', base)` would drop
// a path prefix such as `https://host/imp`, which a reverse proxy may need.
export function buildImpdUrl(base: string, path: string): URL {
  const url = new URL(base);

  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;

  return url;
}
