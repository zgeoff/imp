// What imp-docker-proxy accepts in a query or a body: the values impd's
// `docker` CLI sends (recorded in the tests), and nothing else.

export type Check = { readonly isOk: true } | { readonly isOk: false; readonly reason: string };

const OK: Check = { isOk: true };

function buildFailure(reason: string): Check {
  return { isOk: false, reason };
}

// a build tag: imp/<name>:latest, with NameSchema's name rule (@imp/api)
const BUILD_TAG = /^imp\/[a-z0-9][a-z0-9_.\-]{0,62}:latest$/v;

// the one build arg impd sends, at the one value it sends
const BUILD_ARGS: Readonly<Record<string, string>> = {
  BUILDKIT_SYNTAX: 'docker/dockerfile:1',
};

const ZERO_OR_ONE = new Set(['0', '1']);

interface ParamRule {
  readonly isRequired?: boolean;
  readonly isRepeatable?: boolean;
  readonly check: (value: string) => string | null;
}

function checkOneOf(allowed: ReadonlySet<string>): (value: string) => string | null {
  return (value) => (allowed.has(value) ? null : `is ${JSON.stringify(value)}`);
}

// every param in `query` has a rule and passes it: each value of a
// repeatable one, and a single value of any other
function checkQuery(
  query: ReadonlyMap<string, readonly string[]>,
  rules: Readonly<Record<string, ParamRule>>,
): Check {
  for (const [key, values] of query) {
    const rule = rules[key];

    if (rule === undefined) {
      return buildFailure(`param ${key} is not allowed`);
    }

    if (values.length > 1 && rule.isRepeatable !== true) {
      return buildFailure(`param ${key} is given ${String(values.length)} times`);
    }

    for (const value of values) {
      const problem = rule.check(value);

      if (problem !== null) {
        return buildFailure(`param ${key} ${problem}`);
      }
    }
  }

  for (const [key, rule] of Object.entries(rules)) {
    if (rule.isRequired === true && !query.has(key)) {
      return buildFailure(`param ${key} is missing`);
    }
  }

  return OK;
}

function checkDockerfilePath(value: string): string | null {
  const segments = value.split('/');

  if (
    value === '' ||
    value.startsWith('/') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    !/^[A-Za-z0-9._\/\-]+$/v.test(value)
  ) {
    return `is ${JSON.stringify(value)}, not a path inside the context`;
  }

  return null;
}

function checkBuildArgs(value: string): string | null {
  let parsed: unknown = null;

  try {
    parsed = JSON.parse(value);
  } catch {
    return 'is not JSON';
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'is not an object';
  }

  for (const [key, arg] of Object.entries(parsed)) {
    if (BUILD_ARGS[key] !== arg) {
      return `sets ${key}=${JSON.stringify(arg)}`;
    }
  }

  return null;
}

// POST /build: impd's two `docker build` routes, with every tag imp's own,
// so a second -t cannot retag an image the host runs, imp-host's included
const BUILD_RULES: Readonly<Record<string, ParamRule>> = {
  t: {
    isRequired: true,
    isRepeatable: true,
    check: (value) =>
      BUILD_TAG.test(value) ? null : `${JSON.stringify(value)} is not imp/<name>:latest`,
  },
  q: { check: checkOneOf(ZERO_OR_ONE) },
  dockerfile: { check: checkDockerfilePath },

  // 1 is the classic builder; 2, BuildKit, needs a session the proxy refuses
  version: { isRequired: true, check: checkOneOf(new Set(['1'])) },
  buildargs: { check: checkBuildArgs },
  rm: { check: checkOneOf(ZERO_OR_ONE) },
  forcerm: { check: checkOneOf(ZERO_OR_ONE) },
};

export function checkBuildQuery(query: ReadonlyMap<string, readonly string[]>): Check {
  return checkQuery(query, BUILD_RULES);
}

export interface ImageReference {
  // the registry host, with its port, or docker.io when the name has none
  readonly registry: string;

  // the repository without the registry: library/ubuntu
  readonly path: string;
}

// The parts of a reference as the engine reads them: the first component is
// a registry when it has a dot or a colon, or is localhost.
export function readImageReference(reference: string): ImageReference {
  const withoutDigest = reference.split('@')[0] ?? '';
  const lastSlash = withoutDigest.lastIndexOf('/');
  const tagColon = withoutDigest.indexOf(':', lastSlash + 1);
  const name = tagColon === -1 ? withoutDigest : withoutDigest.slice(0, tagColon);
  const [first = '', ...rest] = name.split('/');

  const isRegistry =
    rest.length > 0 && (first.includes('.') || first.includes(':') || first === 'localhost');

  const registry = isRegistry ? first : 'docker.io';
  const path = isRegistry ? rest.join('/') : name;

  return {
    registry: registry === 'index.docker.io' ? 'docker.io' : registry,
    path: registry === 'docker.io' && !path.includes('/') ? `library/${path}` : path,
  };
}

function readRegistryHost(registry: string): string {
  // [::1]:5000 and [fe80::1]
  if (registry.startsWith('[')) {
    return registry.slice(1, registry.indexOf(']'));
  }

  return registry.split(':')[0] ?? '';
}

// A registry on the host's own loopback or link-local addresses, or any IP
// literal, is refused: a pull or a create would reach a service there.
function checkRegistry(registry: string): string | null {
  const host = readRegistryHost(registry).toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return `registry ${registry} is the host's own`;
  }

  if (/^[0-9.]+$/v.test(host) || host.includes(':')) {
    return `registry ${registry} is an IP address`;
  }

  return null;
}

// An image the proxy will pull or create from: from a named registry, and
// never the repository imp-host and the proxy run from, whose tag a pull
// would move.
export function checkImageReference(reference: string, hostImage: string): Check {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/:@\[\]\-]*$/v.test(reference)) {
    return buildFailure(`image ${JSON.stringify(reference)} is not a reference`);
  }

  const image = readImageReference(reference);
  const problem = checkRegistry(image.registry);

  if (problem !== null) {
    return buildFailure(problem);
  }

  const host = readImageReference(hostImage);

  if (image.registry === host.registry && image.path === host.path) {
    return buildFailure(`image ${reference} is the repository imp-host runs from`);
  }

  return OK;
}

function checkTag(value: string): string | null {
  return /^[A-Za-z0-9_][A-Za-z0-9_.\-]{0,127}$|^sha256:[a-f0-9]{64}$/v.test(value)
    ? null
    : `is ${JSON.stringify(value)}`;
}

// POST /images/create: a pull by fromImage and tag, nothing else (fromSrc
// imports a tarball, repo and changes rewrite one)
export function checkPullQuery(
  query: ReadonlyMap<string, readonly string[]>,
  hostImage: string,
): Check {
  const checked = checkQuery(query, {
    fromImage: { isRequired: true, check: () => null },
    tag: { check: checkTag },
  });

  if (!checked.isOk) {
    return checked;
  }

  return checkImageReference(query.get('fromImage')?.[0] ?? '', hostImage);
}

// DELETE /containers/{id}: `docker rm -f` sends force only
export function checkRemoveQuery(query: ReadonlyMap<string, readonly string[]>): Check {
  return checkQuery(query, { force: { check: checkOneOf(new Set(['0', '1', 'true', 'false'])) } });
}

// no params anywhere else: GET routes and a create take none (no name)
export function checkNoQuery(query: ReadonlyMap<string, readonly string[]>): Check {
  return checkQuery(query, {});
}

// Non-empty values the CLI sends in a create body at its defaults; every
// other key must be empty (null, false, 0, '', [] or {}, all the way down).
const CREATE_DEFAULTS: Readonly<Record<string, unknown>> = {
  AttachStdout: true,
  AttachStderr: true,
};

const HOST_CONFIG_DEFAULTS: Readonly<Record<string, unknown>> = {
  NetworkMode: 'default',
  RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
  MemorySwappiness: -1,
};

// maps whose keys are the data: `{"/x": {}}` sets a volume
const MAP_KEYS = new Set([
  'Volumes',
  'Labels',
  'ExposedPorts',
  'PortBindings',
  'Tmpfs',
  'StorageOpt',
  'Sysctls',
]);

function isEmptyValue(value: unknown, key = ''): boolean {
  if (value === null || value === false || value === 0 || value === '') {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isEmptyValue(item));
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);

    return MAP_KEYS.has(key)
      ? entries.length === 0
      : entries.every(([name, item]) => isEmptyValue(item, name));
  }

  return false;
}

function findNonDefaultKey(
  object: Readonly<Record<string, unknown>>,
  defaults: Readonly<Record<string, unknown>>,
  skip: ReadonlySet<string>,
): string | null {
  for (const [key, value] of Object.entries(object)) {
    if (skip.has(key) || isEmptyValue(value, key)) {
      continue;
    }

    if (!(key in defaults) || !Bun.deepEquals(value, defaults[key])) {
      return key;
    }
  }

  return null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// POST /containers/create: `docker create <image> /bin/true` and nothing
// more. The proxy forwards a body of its own; this decides only whether the
// client may have one. Returns the image.
export function checkCreateBody(
  body: unknown,
  hostImage: string,
): Check & { readonly image?: string } {
  if (!isRecord(body)) {
    return buildFailure('the body is not a JSON object');
  }

  const image = body['Image'];

  if (typeof image !== 'string') {
    return buildFailure('Image is missing');
  }

  if (!Bun.deepEquals(body['Cmd'], ['/bin/true'])) {
    return buildFailure(`Cmd is ${JSON.stringify(body['Cmd'])}, not ["/bin/true"]`);
  }

  const topKey = findNonDefaultKey(body, CREATE_DEFAULTS, new Set(['Image', 'Cmd', 'HostConfig']));

  if (topKey !== null) {
    return buildFailure(`${topKey} is set`);
  }

  const hostConfig = body['HostConfig'] ?? {};

  if (!isRecord(hostConfig)) {
    return buildFailure('HostConfig is not an object');
  }

  const hostKey = findNonDefaultKey(hostConfig, HOST_CONFIG_DEFAULTS, new Set());

  if (hostKey !== null) {
    return buildFailure(`HostConfig.${hostKey} is set`);
  }

  const reference = checkImageReference(image, hostImage);

  return reference.isOk ? { isOk: true, image } : reference;
}
