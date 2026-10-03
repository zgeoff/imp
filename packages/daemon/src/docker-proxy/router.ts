// The Docker API routes imp-docker-proxy lets through: the calls impd and
// its `docker` CLI make (docs/architecture/host-contract.md#the-docker-socket).
// No BuildKit /session or /grpc: a build sends its context as the body.

type Route =
  | { readonly kind: 'ping' }
  | { readonly kind: 'version' }
  | { readonly kind: 'image-inspect'; readonly name: string }
  | { readonly kind: 'image-remove'; readonly name: string }
  | { readonly kind: 'pull' }
  | { readonly kind: 'build' }
  | { readonly kind: 'create' }
  | { readonly kind: 'export'; readonly id: string }
  | { readonly kind: 'remove'; readonly id: string };

export interface RoutedRequest {
  // `/v1.55`, or '' for a client that sent no version prefix
  readonly versionPrefix: string;
  readonly route: Route;

  // each param's values, in the order the client sent them
  readonly query: ReadonlyMap<string, readonly string[]>;
}

export type RouteResult =
  | { readonly isAllowed: true; readonly request: RoutedRequest }
  | { readonly isAllowed: false; readonly reason: string };

const VERSION_PREFIX = /^\/v1\.\d{1,3}(?=\/)/v;

// an image reference: a name, a tag, a digest
const IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/:@\-]*$/v;

// a container ID or name as the CLI sends it
const CONTAINER_ID = /^[A-Za-z0-9][A-Za-z0-9_.\-]*$/v;

export function parseQuery(raw: string): ReadonlyMap<string, readonly string[]> {
  const query = new Map<string, string[]>();

  for (const [key, value] of new URLSearchParams(raw)) {
    query.set(key, [...(query.get(key) ?? []), value]);
  }

  return query;
}

// `?a=1&b=2`, or '' for no params
export function formatQuery(query: ReadonlyMap<string, readonly string[]>): string {
  const params = new URLSearchParams();

  for (const [key, values] of query) {
    for (const value of values) {
      params.append(key, value);
    }
  }

  return params.size === 0 ? '' : `?${params.toString()}`;
}

function buildRefusal(reason: string): RouteResult {
  return { isAllowed: false, reason };
}

function findRoute(method: string, path: string): Route | null {
  if (path === '/_ping' && (method === 'GET' || method === 'HEAD')) {
    return { kind: 'ping' };
  }

  if (path === '/version' && method === 'GET') {
    return { kind: 'version' };
  }

  if (method === 'POST') {
    if (path === '/images/create') {
      return { kind: 'pull' };
    }

    if (path === '/build') {
      return { kind: 'build' };
    }

    if (path === '/containers/create') {
      return { kind: 'create' };
    }

    return null;
  }

  // image names hold slashes: everything between /images/ and /json
  const image = /^\/images\/(?<name>.+)\/json$/v.exec(path)?.groups?.['name'];

  if (method === 'GET' && image !== undefined && IMAGE_NAME.test(image)) {
    return { kind: 'image-inspect', name: image };
  }

  // a reference or an image ID; the proxy checks the image it names
  const removedImage = /^\/images\/(?<name>.+)$/v.exec(path)?.groups?.['name'];

  if (
    method === 'DELETE' &&
    removedImage !== undefined &&
    IMAGE_NAME.test(removedImage) &&
    /[A-Za-z0-9]$/v.test(removedImage)
  ) {
    return { kind: 'image-remove', name: removedImage };
  }

  const exported = /^\/containers\/(?<id>[^\/]+)\/export$/v.exec(path)?.groups?.['id'];

  if (method === 'GET' && exported !== undefined && CONTAINER_ID.test(exported)) {
    return { kind: 'export', id: exported };
  }

  const removed = /^\/containers\/(?<id>[^\/]+)$/v.exec(path)?.groups?.['id'];

  if (method === 'DELETE' && removed !== undefined && CONTAINER_ID.test(removed)) {
    return { kind: 'remove', id: removed };
  }

  return null;
}

// `target` is the path and query, not decoded; Bun's URL has already
// resolved dot segments and `\`. One left, an escape or an empty segment is
// refused, so the proxy checks and forwards one spelling.
export function findRequestRoute(method: string, target: string): RouteResult {
  const queryStart = target.indexOf('?');
  const rawPath = queryStart === -1 ? target : target.slice(0, queryStart);
  const rawQuery = queryStart === -1 ? '' : target.slice(queryStart + 1);

  if (!rawPath.startsWith('/') || /%|\\|\/\/|\/\.\.?(?:\/|$)/v.test(rawPath)) {
    return buildRefusal(`path ${JSON.stringify(rawPath)} is not a plain path`);
  }

  const versionPrefix = VERSION_PREFIX.exec(rawPath)?.[0] ?? '';
  const path = rawPath.slice(versionPrefix.length);
  const route = findRoute(method, path);

  if (route === null) {
    return buildRefusal(`${method} ${path} is not a call impd makes`);
  }

  return { isAllowed: true, request: { versionPrefix, route, query: parseQuery(rawQuery) } };
}
