import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import * as z from 'zod';
import { resolveImageName } from '../lib/fixtures';
import { readImpEnv, runImp, tryImp } from '../lib/imp-cli';
import { createImp } from '../lib/imps';
import { instance, runDevScript } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';

// The public MCP route (docs/guides/mcp.md#public-route): a client signs in,
// a named token approves it with the CLI, and the grant reaches /mcp on the
// route's own port. The instance runs with the route on for this suite only.

const prefix = setupSuite('mcp-oauth');
const box = `${prefix}box`;
const CLIENT = `${prefix}conn`;
const APPROVER = `${prefix}approver`;

// the route's origin: plain http on loopback, as tests alone may use
const ORIGIN = `http://127.0.0.1:${String(7071 + instance.portOffset)}`;
const ROUTE_ENV = { IMP_MCP_PUBLIC_URL: ORIGIN };

const TokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  scope: z.string(),
});

const ErrorSchema = z.object({ error: z.string() });
const ToolSchema = z.object({ name: z.string() });
const ToolsSchema = z.object({ result: z.object({ tools: z.array(ToolSchema) }) });

// the redirect URI's server: it takes the code a sign-in sends back
const catcher = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () => new Response('signed in'),
});

const REDIRECT = `http://127.0.0.1:${String(catcher.port)}/callback`;
const state: { clientId: string; approverToken: string } = { clientId: '', approverToken: '' };

beforeAll(async () => {
  Object.assign(process.env, ROUTE_ENV);

  await runDevScript('reboot');
  await createImp(box, '--image', resolveImageName('e2e-tiny'), '--memory', '256');
  await tryImp(['oauth', 'client', 'rm', CLIENT]);
  await tryImp(['token', 'rm', APPROVER]);

  const clientId = await runImp('oauth', 'client', 'add', CLIENT, '--redirect-uri', REDIRECT);

  const approverToken = await runImp(
    'token',
    'new',
    APPROVER,
    '--scope',
    'exec',
    '--imps',
    `${prefix}*`,
  );

  state.clientId = clientId.trim();
  state.approverToken = approverToken.trim();
}, 600_000);

afterAll(async () => {
  await catcher.stop(true);

  await tryImp(['oauth', 'client', 'rm', CLIENT]);
  await tryImp(['token', 'rm', APPROVER]);

  for (const key of Object.keys(ROUTE_ENV)) {
    delete process.env[key];
  }

  // the instance goes back to the route off
  await runDevScript('reboot');
}, 600_000);

function createVerifier(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  return { verifier, challenge };
}

function sendForm(
  path: string,
  fields: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>> = {},
) {
  return fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

// a sign-in from the page to the client's tokens, approved with the CLI
async function runSignIn(scope: string) {
  const pkce = createVerifier();

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: state.clientId,
    redirect_uri: REDIRECT,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: 'e2e',
    scope: 'read exec',
    resource: `${ORIGIN}/mcp`,
  });

  const opened = await fetch(`${ORIGIN}/oauth/authorize?${query.toString()}`);
  const page = await opened.text();

  expect(opened.status).toBe(200);
  expect(opened.headers.get('referrer-policy')).toBe('same-origin');

  const code = /imp oauth approve (?<code>[A-Z0-9-]+)/u.exec(page)?.groups?.['code'] ?? '';
  const id = /name="id" value="(?<id>[^"]+)"/u.exec(page)?.groups?.['id'] ?? '';
  const signature = /name="signature" value="(?<sig>[^"]+)"/u.exec(page)?.groups?.['sig'] ?? '';

  const approved = await tryImp(['oauth', 'approve', code, '--scope', scope, '--yes'], {
    token: state.approverToken,
  });

  expect(approved.exitCode).toBe(0);
  expect(approved.stderr).toContain(`client:       ${CLIENT}`);
  expect(approved.stderr).toContain(`returns to:   ${REDIRECT}`);

  // as a browser posts it from a page whose referrer policy is same-origin
  // or stricter: Origin null, and Sec-Fetch-Site it sets itself
  const allowed = await sendForm(
    '/oauth/authorize',
    { id, signature, action: 'allow' },
    { origin: 'null', 'sec-fetch-site': 'same-origin' },
  );

  const location = new URL(allowed.headers.get('location') ?? '');

  expect(allowed.status).toBe(302);
  expect(allowed.headers.get('referrer-policy')).toBe('no-referrer');
  expect(location.searchParams.get('iss')).toBe(ORIGIN);
  expect(location.searchParams.get('state')).toBe('e2e');

  // the browser follows the redirect to the client
  const caught = await fetch(location);

  expect(caught.status).toBe(200);

  const exchanged = await sendForm('/oauth/token', {
    grant_type: 'authorization_code',
    client_id: state.clientId,
    code: location.searchParams.get('code') ?? '',
    redirect_uri: REDIRECT,
    code_verifier: pkce.verifier,
    resource: `${ORIGIN}/mcp`,
  });

  const body: unknown = await exchanged.json();

  return TokenSchema.parse(body);
}

// a JSON-RPC call on the public /mcp; the answer is the last SSE event or
// the JSON body
async function sendMcp(bearer: string, session: string, method: string, params: unknown = {}) {
  const response = await fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(session !== '' && { 'mcp-session-id': session }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  const text = await response.text();

  const events = text.split('\n').filter((line) => line.startsWith('data: '));
  const last = events.at(-1)?.slice('data: '.length) ?? text;
  const body = parseBody(last);

  return { status: response.status, session: response.headers.get('mcp-session-id') ?? '', body };
}

// a JSON body, or the text of one that is not JSON, such as a 401's
function parseBody(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);

    return parsed;
  } catch {
    return text;
  }
}

// whether a call got its result, or its stream ended with none
async function readCallOutcome(call: Promise<{ readonly body: unknown }>): Promise<string> {
  try {
    const answer = await call;

    return JSON.stringify(answer.body).includes('"result"') ? 'answered' : 'dropped';
  } catch {
    return 'dropped';
  }
}

async function openMcp(bearer: string): Promise<string> {
  const opened = await sendMcp(bearer, '', 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e' },
  });

  expect(opened.status).toBe(200);

  return opened.session;
}

test('the route serves its discovery documents and nothing private', async () => {
  const metadata = await fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
  const resource = await fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
  const unauthorized = await fetch(`${ORIGIN}/mcp`, { method: 'POST' });
  const issuer: unknown = await metadata.json();
  const protectedResource: unknown = await resource.json();

  expect(issuer).toMatchObject({
    issuer: ORIGIN,
    code_challenge_methods_supported: ['S256'],
  });

  expect(protectedResource).toMatchObject({
    resource: `${ORIGIN}/mcp`,
    authorization_servers: [ORIGIN],
  });

  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get('www-authenticate')).toContain('resource_metadata=');

  for (const path of ['/rpc/system/info', '/health', '/ui/']) {
    const response = await fetch(`${ORIGIN}${path}`);

    expect(response.status).toBe(404);
  }

  // the instance's root token is no way in
  const env = await readImpEnv();

  const withRoot = await fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env['IMP_TOKEN'] ?? ''}` },
  });

  expect(withRoot.status).toBe(401);
});

test('a grant lists the tools its scope allows and runs a command in its imps', async () => {
  const tokens = await runSignIn('exec');

  expect(tokens.scope).toBe('read exec');

  const session = await openMcp(tokens.access_token);
  const listed = await sendMcp(tokens.access_token, session, 'tools/list');

  const names = ToolsSchema.parse(listed.body).result.tools.map((tool) => tool.name);

  expect(names).toContain('imp_exec');
  expect(names).not.toContain('imp_create');

  const ran = await sendMcp(tokens.access_token, session, 'tools/call', {
    name: 'imp_exec',
    arguments: { name: box, command: 'echo from-the-route' },
  });

  expect(JSON.stringify(ran.body)).toContain('from-the-route');

  const grants = await runImp('oauth', 'grant', 'ls');

  expect(grants).toContain(CLIENT);
  expect(grants).toContain(APPROVER);
});

test('a refresh rotates, and a spent refresh token presented again ends the grant', async () => {
  const first = await runSignIn('read');

  const sendRefresh = (token: string) =>
    sendForm('/oauth/token', {
      grant_type: 'refresh_token',
      client_id: state.clientId,
      refresh_token: token,
    });

  const rotated = await sendRefresh(first.refresh_token);
  const rotatedBody: unknown = await rotated.json();

  const second = TokenSchema.parse(rotatedBody);

  expect(second.scope).toBe('read');

  const replayed = await sendRefresh(first.refresh_token);
  const replayBody: unknown = await replayed.json();

  expect(ErrorSchema.parse(replayBody).error).toBe('invalid_grant');

  const after = await sendMcp(second.access_token, '', 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e' },
  });

  expect(after.status).toBe(401);
});

test('removing the approving token stops the command a grant runs, then answers 401', async () => {
  const tokens = await runSignIn('exec');
  const session = await openMcp(tokens.access_token);

  const call = readCallOutcome(
    sendMcp(tokens.access_token, session, 'tools/call', {
      name: 'imp_exec',
      arguments: { name: box, command: 'sleep 120', timeoutSeconds: 180 },
    }),
  );

  await Bun.sleep(2000);

  const started = Date.now();

  await runImp('token', 'rm', APPROVER);

  const ended = await call;

  // the stream closed long before the command's 120 s
  expect(ended).toBe('dropped');
  expect(Date.now() - started).toBeLessThan(30_000);

  const after = await sendMcp(tokens.access_token, session, 'ping');

  expect(after.status).toBe(401);

  const processes = await runImp('exec', box, '--', 'ps');

  expect(processes).not.toContain('sleep 120');

  // a new approver for the cases after this one
  const remade = await runImp('token', 'new', APPROVER, '--scope', 'exec', '--imps', `${prefix}*`);

  state.approverToken = remade.trim();
}, 120_000);

test('sign-ins past the burst get 429', async () => {
  const statuses: number[] = [];
  const pkce = createVerifier();

  for (let index = 0; index < 12; index += 1) {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: state.clientId,
      redirect_uri: REDIRECT,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    });

    const response = await fetch(`${ORIGIN}/oauth/authorize?${query.toString()}`);

    statuses.push(response.status);
  }

  expect(statuses).toContain(429);
});
