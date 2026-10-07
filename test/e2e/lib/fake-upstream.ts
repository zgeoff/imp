import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { runChecked } from './instance';

const OAUTH_CLIENT_ID = 'e2e-client';

// A fake github.com and api.github.com on this machine: git smart HTTP
// behind Basic auth, a check of the bearer token, and a fake OAuth token
// endpoint. It never echoes a token, which would put it in the guest's memory.

interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
}

// the OAuth side: /oauth/token takes a JSON refresh request and rotates the
// refresh token each time, and /oauth-e2e/me says whether the bearer token is
// the access token issued last. Every token is made up for the run.
export interface FakeOAuth {
  readonly clientId: string;

  // the refresh token a secret starts from
  readonly firstRefreshToken: string;

  // each token issued, in order
  readonly accessTokens: () => readonly string[];
  readonly refreshTokens: () => readonly string[];

  // how many refresh requests were refused
  readonly refused: () => number;

  // the status the endpoint answers a refresh token, as a request would; a
  // current one is exchanged
  readonly exchange: (refreshToken: string) => number;
}

export interface FakeUpstream extends AsyncDisposable {
  readonly oauth: FakeOAuth;

  // https://<address>:<port>, for the broker's test-upstreams file
  readonly origin: string;
  readonly caPem: string;
  readonly seen: readonly SeenRequest[];

  // a bare repo at <owner>/<repo>.git that accepts pushes
  readonly createRepo: (path: string) => Promise<string>;
}

const CGI_HEADER_END = /\r?\n\r?\n/;

export async function startFakeUpstream(address: string, token: string): Promise<FakeUpstream> {
  const dir = mkdtempSync(join(tmpdir(), 'imp-e2e-upstream-'));
  const repos = join(dir, 'repos');
  const expected = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  const bearer = `Bearer ${token}`;
  const seen: SeenRequest[] = [];

  mkdirSync(repos);

  await createCertificates(dir, address);

  const oauthState = {
    refreshTokens: [`e2e-refresh-${randomUUID()}`],
    accessTokens: [] as string[],
    refused: 0,
  };

  const runTokenExchange = (refreshToken: string): { status: number; body: unknown } => {
    if (refreshToken !== oauthState.refreshTokens.at(-1)) {
      oauthState.refused += 1;

      return { status: 400, body: { error: 'invalid_grant' } };
    }

    const access = `e2e-access-${randomUUID()}`;
    const refresh = `e2e-refresh-${randomUUID()}`;

    oauthState.accessTokens.push(access);
    oauthState.refreshTokens.push(refresh);

    return {
      status: 200,
      body: { access_token: access, refresh_token: refresh, expires_in: 3600 },
    };
  };

  const handleToken = async (request: Request): Promise<Response> => {
    const payload: unknown = await request.json().catch(() => null);

    const fields = z
      .object({ client_id: z.string(), refresh_token: z.string() })
      .safeParse(payload);

    if (!fields.success || fields.data.client_id !== OAUTH_CLIENT_ID) {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }

    const answer = runTokenExchange(fields.data.refresh_token);

    return Response.json(answer.body, { status: answer.status });
  };

  const handleGit = async (request: Request, path: string, query: string): Promise<Response> => {
    if (request.headers.get('authorization') !== expected) {
      return new Response('auth needed\n', {
        status: 401,
        headers: { 'www-authenticate': 'Basic realm="fake"' },
      });
    }

    const received = await request.arrayBuffer();

    const body = new Uint8Array(received);

    const child = Bun.spawn(['git', 'http-backend'], {
      stdin: body,
      stdout: 'pipe',
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: repos,
        GIT_HTTP_EXPORT_ALL: '1',
        REMOTE_USER: 'x-access-token',
        REQUEST_METHOD: request.method,
        PATH_INFO: path,
        QUERY_STRING: query,
        CONTENT_TYPE: request.headers.get('content-type') ?? '',
        HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '',
      },
    });

    const output = await new Response(child.stdout).arrayBuffer();

    await child.exited;

    return parseCgiOutput(new Uint8Array(output));
  };

  const server = Bun.serve({
    hostname: '0.0.0.0',
    port: 0,
    tls: { cert: readFileSync(join(dir, 'leaf.pem')), key: readFileSync(join(dir, 'leaf.key')) },
    maxRequestBodySize: 256 * 1024 ** 2,
    idleTimeout: 60,
    fetch: (request) => {
      const url = new URL(request.url);

      seen.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get('authorization'),
      });

      if (url.pathname === '/oauth/token' && request.method === 'POST') {
        return handleToken(request);
      }

      if (url.pathname === '/oauth-e2e/me') {
        const current = oauthState.accessTokens.at(-1);

        return Response.json({
          generation: oauthState.accessTokens.length,
          authorized:
            current !== undefined && request.headers.get('authorization') === `Bearer ${current}`,
        });
      }

      if (url.pathname.includes('.git/')) {
        return handleGit(request, url.pathname, url.search.slice(1));
      }

      return Response.json({ authorized: request.headers.get('authorization') === bearer });
    },
  });

  return {
    oauth: {
      clientId: OAUTH_CLIENT_ID,
      firstRefreshToken: oauthState.refreshTokens[0] ?? '',
      accessTokens: () => [...oauthState.accessTokens],
      refreshTokens: () => [...oauthState.refreshTokens],
      refused: () => oauthState.refused,
      exchange: (refreshToken) => runTokenExchange(refreshToken).status,
    },
    origin: `https://${address}:${String(server.port)}`,
    caPem: readFileSync(join(dir, 'ca.pem'), 'utf8'),
    seen,
    createRepo: async (path) => {
      const repo = join(repos, path);

      await runChecked(['git', 'init', '-q', '--bare', '-b', 'main', repo]);
      await runChecked(['git', '-C', repo, 'config', 'http.receivepack', 'true']);

      return repo;
    },
    [Symbol.asyncDispose]: async () => {
      await server.stop(true);

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// a CA and a leaf for the address, by openssl on this machine
async function createCertificates(dir: string, address: string): Promise<void> {
  const ca = join(dir, 'ca');
  const leaf = join(dir, 'leaf');
  const ext = join(dir, 'leaf.ext');

  writeFileSync(
    ext,
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=IP:${address}`,
      'authorityKeyIdentifier=keyid',
    ].join('\n'),
  );

  await runOpenssl([
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    `${ca}.key`,
    '-out',
    `${ca}.pem`,
    '-days',
    '2',
    '-subj',
    '/CN=imp e2e upstream CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign',
  ]);

  await runOpenssl([
    'req',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    `${leaf}.key`,
    '-out',
    `${leaf}.csr`,
    '-subj',
    `/CN=${address}`,
  ]);

  await runOpenssl([
    'x509',
    '-req',
    '-in',
    `${leaf}.csr`,
    '-CA',
    `${ca}.pem`,
    '-CAkey',
    `${ca}.key`,
    '-CAcreateserial',
    '-out',
    `${leaf}.pem`,
    '-days',
    '2',
    '-extfile',
    ext,
  ]);
}

function runOpenssl(argv: readonly string[]): Promise<string> {
  return runChecked(['openssl', ...argv]);
}

// `git http-backend` writes CGI: headers, a blank line, the body
function parseCgiOutput(output: Uint8Array): Response {
  const text = Buffer.from(output).toString('latin1');
  const match = CGI_HEADER_END.exec(text);
  const headEnd = match?.index ?? text.length;
  const bodyStart = headEnd + (match?.[0].length ?? 0);

  const headers = new Headers();

  let status = 200;

  for (const line of text.slice(0, headEnd).split(/\r?\n/)) {
    const at = line.indexOf(':');
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();

    if (name.toLowerCase() === 'status') {
      status = Number(value.split(' ')[0]);
    } else if (name !== '') {
      headers.set(name, value);
    }
  }

  return new Response(output.subarray(bodyStart), { status, headers });
}
