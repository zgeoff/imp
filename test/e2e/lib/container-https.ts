import { runInContainer } from './instance';

// Requests from inside the host container, where impd's listeners answer on
// loopback, checked against Pebble's root (the repo is mounted at /src).

const TIME_MARK = 'imp-e2e-time-total:';

export interface ContainerRequestOptions {
  // another Host on the same connection
  readonly host?: string;
  readonly authorization?: string;
}

export interface ContainerResponse {
  readonly status: number;
  readonly headers: string;
  readonly body: string;

  // curl's time_total: connect, TLS, the wake, and the response
  readonly totalMs: number;
}

// curl's argv for the URL: its name resolves to loopback on the URL's port,
// the headers go to stderr, and the body to stdout with the total time last
export function buildContainerCurlArgv(
  url: string,
  options: Readonly<ContainerRequestOptions> = {},
): readonly string[] {
  const target = new URL(url);

  const defaultPort = target.protocol === 'https:' ? '443' : '80';
  const port = target.port === '' ? defaultPort : target.port;

  return [
    'curl',
    '-sS',
    '--max-time',
    '30',
    '--cacert',
    '/src/.cache/e2e/pebble-root.pem',
    '--resolve',
    `${target.hostname}:${port}:127.0.0.1`,
    '-D',
    '/dev/stderr',
    '-o',
    '/dev/stdout',
    '-w',
    `\n${TIME_MARK}%{time_total}`,
    ...(options.host === undefined ? [] : ['-H', `Host: ${options.host}`]),
    ...(options.authorization === undefined
      ? []
      : ['-H', `Authorization: ${options.authorization}`]),
    url,
  ];
}

// what that argv printed: the last status line's code, 0 for none
export function parseContainerCurl(stdout: string, stderr: string): ContainerResponse {
  const status = /^HTTP\/[\d.]+ (?<status>\d{3})/mv.exec(stderr)?.groups?.['status'];
  const [body = '', seconds = '0'] = stdout.split(`\n${TIME_MARK}`);

  return {
    status: Number(status ?? 0),
    headers: stderr,
    body: body.trim(),
    totalMs: Math.round(Number(seconds) * 1000),
  };
}

// Thin glue over the host container: throws when curl fails, as on a
// certificate that does not chain to Pebble's root or cover the name.
export async function readInContainer(
  url: string,
  options: Readonly<ContainerRequestOptions> = {},
): Promise<ContainerResponse> {
  const result = await runInContainer(buildContainerCurlArgv(url, options));

  if (result.exitCode !== 0) {
    throw new Error(`curl ${url} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }

  return parseContainerCurl(result.stdout, result.stderr);
}
