import { expect, test } from 'bun:test';
import { ApprovalCodeSchema } from '@imp/api';
import type { Scope } from '@imp/api';
import * as z from 'zod';
import { listApiCalls } from '../db/api-audit';
import { setupImpdTest } from '../mcp/test-mcp';
import { createPublicHandler, startPublicListener } from './public-listener';

const ORIGIN = 'http://127.0.0.1:7171';
const HOST = '127.0.0.1:7171';
const REDIRECT = 'https://client.example/callback';

// RFC 7636, appendix B
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const TokenSchema = z.object({ access_token: z.string(), scope: z.string() });
const TextItemSchema = z.object({ text: z.string() });
const ToolItemSchema = z.object({ name: z.string() });
const ContentSchema = z.object({ content: z.array(TextItemSchema) });
const ToolListSchema = z.object({ tools: z.array(ToolItemSchema) });
const ToolResultSchema = z.object({ result: ContentSchema });
const ToolsSchema = z.object({ result: ToolListSchema });

interface SendInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

async function setupTest() {
  const impd = await setupImpdTest({
    env: { IMP_MCP_PUBLIC_URL: ORIGIN, IMP_MCP_PUBLIC_PORT: '7171' },
  });

  const config = impd.config.publicMcp;

  if (config === null) {
    throw new Error('the public route is off');
  }

  const handle = createPublicHandler({ config, oauth: impd.oauth, mcp: impd.publicMcp });

  const client = await impd.oauth.addClient('conn', [REDIRECT]);

  // a request as the TLS front passes it on
  const send = (path: string, init: SendInit = {}) => {
    const headers = new Headers(init.headers);

    if (!headers.has('host')) {
      headers.set('host', HOST);
    }

    return handle(new Request(`${ORIGIN}${path}`, { ...init, headers }), null);
  };

  const sendForm = (path: string, fields: Readonly<Record<string, string>>, headers = {}) =>
    send(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
    });

  // a whole sign-in over HTTP, approved by a named token, to an access token
  const runSignIn = async (tokenName: string, scope: Scope = 'exec', imps?: readonly string[]) => {
    const made = await impd.tokens.create({ name: tokenName, scope: 'manage', imps: null });

    const approver = impd.tokens.authenticate(made.secret);

    if (approver === null) {
      throw new Error('no approver');
    }

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      state: 'st',
      scope: 'read exec manage',
      resource: `${ORIGIN}/mcp`,
    });

    const authorized = await send(`/oauth/authorize?${query.toString()}`);
    const page = await authorized.text();

    const code = /imp oauth approve (?<code>[A-Z0-9-]+)/.exec(page)?.groups?.['code'] ?? '';
    const id = /name="id" value="(?<id>[^"]+)"/.exec(page)?.groups?.['id'] ?? '';

    const signature =
      /name="signature" value="(?<signature>[^"]+)"/.exec(page)?.groups?.['signature'] ?? '';

    impd.oauth.approve(ApprovalCodeSchema.parse(code), approver, scope, imps);

    const allowed = await sendForm(
      '/oauth/authorize',
      { id, signature, action: 'allow' },
      { origin: ORIGIN },
    );

    const location = new URL(allowed.headers.get('location') ?? '');

    // the redirect to the client sends no referrer at all
    expect(allowed.headers.get('referrer-policy')).toBe('no-referrer');

    const tokens = await sendForm('/oauth/token', {
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: location.searchParams.get('code') ?? '',
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });

    const body = await tokens.json();

    return TokenSchema.parse(body);
  };

  // an MCP client on the public /mcp
  const openMcp = async (bearer: string) => {
    const state = { session: '', nextId: 1 };

    const sendPost = (body: unknown) =>
      send('/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${bearer}`,
          ...(state.session !== '' && { 'mcp-session-id': state.session }),
        },
        body: JSON.stringify(body),
      });

    const opened = await sendPost({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    });

    expect(opened.status).toBe(200);

    state.session = opened.headers.get('mcp-session-id') ?? '';

    // read to its end, as a client does, so it holds no slot
    await opened.text();

    const sendRequest = async (method: string, params: unknown = {}) => {
      const response = await sendPost({ jsonrpc: '2.0', id: state.nextId++, method, params });
      const text = await response.text();

      const data = text.split('\n').find((line) => line.startsWith('data: '));

      return { status: response.status, body: parseJson(data?.slice(6) ?? text) };
    };

    const sendDelete = () =>
      send('/mcp', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${bearer}`, 'mcp-session-id': state.session },
      });

    return { sendPost, sendRequest, sendDelete };
  };

  return { ...impd, handle, client, send, sendForm, runSignIn, openMcp };
}

test('it serves the discovery documents the MCP spec names', async () => {
  await using ctx = await setupTest();

  for (const path of [
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-protected-resource',
  ]) {
    const response = await ctx.send(path);

    expect(response.status).toBe(200);

    const body = await response.json();

    expect(body).toEqual({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
      scopes_supported: ['read', 'exec', 'manage'],
      bearer_methods_supported: ['header'],
      resource_name: 'imp',
    });
  }

  const metadata = await ctx.send('/.well-known/oauth-authorization-server');
  const document = await metadata.json();

  expect(document).toEqual({
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/oauth/authorize`,
    token_endpoint: `${ORIGIN}/oauth/token`,
    revocation_endpoint: `${ORIGIN}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['read', 'exec', 'manage'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  });
});

test('every private path, and every other host, gets the same 404', async () => {
  await using ctx = await setupTest();

  for (const path of ['/rpc/system/info', '/health', '/auth/login', '/exec', '/', '/index.html']) {
    const response = await ctx.send(path, { headers: { authorization: `Bearer ${ctx.token}` } });

    expect(response.status).toBe(404);

    const text = await response.text();

    expect(text).toBe('not found');
  }

  for (const host of ['evil.example', '127.0.0.1:7070', 'localhost:7171']) {
    const response = await ctx.send('/.well-known/oauth-authorization-server', {
      headers: { host },
    });

    expect(response.status).toBe(404);
  }
});

test('/mcp takes only an OAuth access token: no imp token, peer or forwarded header', async () => {
  await using ctx = await setupTest();

  const named = await ctx.tokens.create({ name: 'named', scope: 'manage', imps: null });

  const attempts: Record<string, string>[] = [
    {},
    { authorization: `Bearer ${ctx.token}` },
    { authorization: `Bearer ${named.secret}` },
    { 'x-forwarded-for': '100.101.102.103', 'x-imp-peer': '100.101.102.103' },
    { 'cf-connecting-ip': '127.0.0.1', cookie: 'imp_session=anything' },
    { authorization: 'Bearer impat_guess.wrong' },
  ];

  for (const headers of attempts) {
    const response = await ctx.send('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    });

    expect(response.status).toBe(401);

    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="read"`,
    );
  }
});

test('the sign-in page escapes what it shows, and sends no referrer elsewhere', async () => {
  await using ctx = await setupTest();

  const odd = 'https://client.example/cb?next=%22%3E&x=<b>"\'';

  await ctx.oauth.updateClient('conn', [odd]);

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.client.clientId,
    redirect_uri: odd,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    scope: 'read',
  });

  const response = await ctx.send(`/oauth/authorize?${query.toString()}`);
  const page = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get('referrer-policy')).toBe('same-origin');
  expect(response.headers.get('x-frame-options')).toBe('DENY');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");

  expect(response.headers.get('content-security-policy')).toContain(
    "form-action 'self' https://client.example",
  );

  // Continue after approval shows the full redirect URI, escaped
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);
  const code = /imp oauth approve (?<code>[A-Z0-9-]+)/.exec(page)?.groups?.['code'] ?? '';
  const id = /name="id" value="(?<id>[^"]+)"/.exec(page)?.groups?.['id'] ?? '';

  const signature =
    /name="signature" value="(?<signature>[^"]+)"/.exec(page)?.groups?.['signature'] ?? '';

  if (approver === null) {
    throw new Error('no approver');
  }

  ctx.oauth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);

  const confirmed = await ctx.sendForm(
    '/oauth/authorize',
    { id, signature, action: 'continue' },
    { origin: ORIGIN },
  );

  const text = await confirmed.text();

  expect(text).toContain('<strong>read</strong>');
  expect(text).toContain('x=&lt;b&gt;&quot;&#39;');
  expect(text).not.toContain('<b>"');
});

test('a refused sign-in page carries no Location, and a form from another origin is refused', async () => {
  await using ctx = await setupTest();

  const unknown = await ctx.send(
    '/oauth/authorize?client_id=impc_guess&redirect_uri=https://evil.example',
  );

  expect(unknown.status).toBe(400);
  expect(unknown.headers.get('location')).toBeNull();
  expect(unknown.headers.get('referrer-policy')).toBe('same-origin');

  const unknownText = await unknown.text();

  expect(unknownText).not.toContain('evil.example');
});

test('a browser’s form counts by its Origin, or by Sec-Fetch-Site when Origin is null', async () => {
  await using ctx = await setupTest();

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: ctx.client.clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  });

  const opened = await ctx.send(`/oauth/authorize?${query.toString()}`);
  const page = await opened.text();

  const id = /name="id" value="(?<id>[^"]+)"/.exec(page)?.groups?.['id'] ?? '';
  const signature = /name="signature" value="(?<sig>[^"]+)"/.exec(page)?.groups?.['sig'] ?? '';
  const statuses: number[] = [];

  for (const headers of [
    { origin: ORIGIN },
    { origin: 'null', 'sec-fetch-site': 'same-origin' },
    { origin: 'null' },
    { origin: 'null', 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-origin' },
    { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' },
    {},
  ]) {
    const posted = await ctx.sendForm(
      '/oauth/authorize',
      { id, signature, action: 'continue' },
      headers,
    );

    statuses.push(posted.status);
  }

  // Continue shows the page again; a refused form gets the error page
  expect(statuses).toEqual([200, 200, 400, 400, 400, 400, 400]);
});

test('the token endpoint takes a small form and caches nothing', async () => {
  await using ctx = await setupTest();

  const json = await ctx.send('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

  expect(json.status).toBe(400);

  const jsonBody = await json.json();

  expect(jsonBody).toMatchObject({ error: 'invalid_request' });

  const large = await ctx.sendForm('/oauth/token', { grant_type: 'x'.repeat(17 * 1024) });

  expect(large.status).toBe(400);

  const unknown = await ctx.sendForm('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: 'impc_guess',
  });

  expect(unknown.status).toBe(401);
  expect(unknown.headers.get('cache-control')).toBe('no-store');
});

test('a grant’s MCP session runs its tools, and revoking the grant ends its command', async () => {
  await using ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'box', image: 'ubuntu' });

  const tokens = await ctx.runSignIn('laptop', 'exec');

  expect(tokens.scope).toBe('read exec');

  const mcp = await ctx.openMcp(tokens.access_token);
  const listing = await mcp.sendRequest('tools/list');

  const listed = ToolsSchema.parse(listing.body);

  expect(listed.result.tools.map((tool) => tool.name)).toContain('imp_exec');
  expect(listed.result.tools.map((tool) => tool.name)).not.toContain('imp_create');

  const call = mcp.sendRequest('tools/call', {
    name: 'imp_exec',
    arguments: { name: 'box', command: 'sleepy' },
  });

  while (ctx.guest.requests.length === 0) {
    await Bun.sleep(10);
  }

  const [grant] = await ctx.oauth.listGrants();

  await ctx.oauth.removeGrant(grant?.id ?? '');

  const failure = await call.then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  expect(ctx.guest.closed).toContain('sleepy');

  const after = await mcp.sendPost({ jsonrpc: '2.0', id: 9, method: 'ping' });

  expect(after.status).toBe(401);
});

test('a grant narrower than its token gets only its own scope and imps', async () => {
  await using ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'box', image: 'ubuntu' });
  await ctx.rootClient.imps.create({ name: 'dev-a', image: 'ubuntu' });

  const readerTokens = await ctx.runSignIn('laptop', 'read');
  const reader = await ctx.openMcp(readerTokens.access_token);
  const readerListing = await reader.sendRequest('tools/list');

  const listed = ToolsSchema.parse(readerListing.body);

  expect(listed.result.tools.map((tool) => tool.name)).toEqual([
    'imp_list',
    'imp_url',
    'imp_image_list',
    'imp_checkpoint_list',
  ]);

  const devTokens = await ctx.runSignIn('desk', 'exec', ['dev-*']);
  const devOnly = await ctx.openMcp(devTokens.access_token);

  for (const [mcp, name] of [
    [reader, 'dev-a'],
    [devOnly, 'box'],
  ] as const) {
    const called = await mcp.sendRequest('tools/call', {
      name: 'imp_exec',
      arguments: { name, command: 'echo hi' },
    });

    const text = ToolResultSchema.parse(called.body).result.content[0]?.text ?? '';

    expect(text.slice(0, 10)).toBe('FORBIDDEN:');
  }

  expect(ctx.guest.requests).toEqual([]);

  // a change it may make lands in the audit log under its client and id
  await devOnly.sendRequest('tools/call', { name: 'imp_sleep', arguments: { name: 'dev-a' } });

  const grants = await ctx.oauth.listGrants();

  const desk = grants.find((grant) => grant.token === 'desk');

  const calls = await listApiCalls(ctx.db, null, 100, null);

  const byGrants = calls.filter((call) => call.actor === 'oauth');

  expect(byGrants.map((call) => [call.procedure, call.actorName])).toEqual([
    ['imps.sleep', `conn/${desk?.id ?? ''}`],
  ]);
});

test('removing the approving token ends every grant it approved, and their commands', async () => {
  await using ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'box', image: 'ubuntu' });

  const first = await ctx.runSignIn('laptop', 'exec');
  const mcp = await ctx.openMcp(first.access_token);

  const call = mcp.sendRequest('tools/call', {
    name: 'imp_exec',
    arguments: { name: 'box', command: 'sleepy' },
  });

  while (ctx.guest.requests.length === 0) {
    await Bun.sleep(10);
  }

  await ctx.tokens.remove('laptop');

  const failure = await call.then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  expect(ctx.guest.closed).toContain('sleepy');

  const after = await mcp.sendPost({ jsonrpc: '2.0', id: 9, method: 'ping' });

  expect(after.status).toBe(401);
});

test('the listener serves the route on its own port', async () => {
  await using ctx = await setupTest();

  const config = ctx.config.publicMcp;

  if (config === null) {
    throw new Error('the public route is off');
  }

  const logs: string[] = [];

  const listener = startPublicListener(
    { config: { ...config, port: 0 }, oauth: ctx.oauth, mcp: ctx.publicMcp },
    (line) => {
      logs.push(line);
    },
  );

  try {
    const url = `http://127.0.0.1:${String(listener.port)}`;

    const found = await fetch(`${url}/.well-known/oauth-authorization-server`, {
      headers: { host: HOST },
    });

    const elsewhere = await fetch(`${url}/.well-known/oauth-authorization-server`);

    expect(found.status).toBe(200);
    expect(elsewhere.status).toBe(404);
  } finally {
    await listener.stop();
  }
});

test('a tool call keeps its room until the tool ends, though its client goes', async () => {
  await using ctx = await setupTest();

  const config = ctx.config.publicMcp;

  if (config === null) {
    throw new Error('the public route is off');
  }

  // an MCP endpoint whose every answer is a call's stream; the test ends
  // each call's tool by hand
  const toolEnds: (() => void)[] = [];

  const callEnds = new WeakMap<Response, Promise<void>>();

  const mcp = {
    handle: () => {
      const body = new ReadableStream<Uint8Array>({ start: () => {} });
      const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });

      const ended = Promise.withResolvers<void>();

      toolEnds.push(ended.resolve);
      callEnds.set(response, ended.promise);

      return Promise.resolve(response);
    },
    close: () => Promise.resolve(),
    readCallEnd: (response: Response) => callEnds.get(response) ?? null,
  };

  const handle = createPublicHandler({ config, oauth: ctx.oauth, mcp });

  const sendCall = () =>
    handle(new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { host: HOST } }), null);

  // 64 long calls whose clients go away at once
  for (let index = 0; index < 64; index += 1) {
    const response = await sendCall();

    expect(response.status).toBe(200);

    await response.body?.cancel();
  }

  const refused = await sendCall();

  expect(refused.status).toBe(429);

  // one tool ends, and its room is free again
  toolEnds[0]?.();

  await Bun.sleep(0);

  const next = await sendCall();

  expect(next.status).toBe(200);
});

test('with every slot held, a cancel still gets through, stops its tool and frees a slot', async () => {
  await using ctx = await setupTest();

  await ctx.rootClient.imps.create({ name: 'box', image: 'ubuntu' });

  const tokens = await ctx.runSignIn('laptop', 'exec');
  const mcp = await ctx.openMcp(tokens.access_token);

  // 64 long calls whose clients go away at once
  for (let index = 1; index <= 64; index += 1) {
    const response = await mcp.sendPost({
      jsonrpc: '2.0',
      id: index,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
    });

    expect(response.status).toBe(200);

    await response.body?.cancel();
  }

  while (ctx.guest.requests.length < 64) {
    await Bun.sleep(10);
  }

  const refused = await mcp.sendPost({ jsonrpc: '2.0', id: 100, method: 'ping' });

  expect(refused.status).toBe(429);

  // a notification and a DELETE start no work, so they still get through
  const cancelled = await mcp.sendPost({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 1 },
  });

  expect(cancelled.status).toBe(202);

  while (!ctx.guest.signals.includes('sleepy:15')) {
    await Bun.sleep(10);
  }

  const statuses: number[] = [];

  for (let attempt = 0; attempt < 100 && statuses.at(-1) !== 200; attempt += 1) {
    const next = await mcp.sendPost({ jsonrpc: '2.0', id: 101, method: 'ping' });

    statuses.push(next.status);

    await next.text();
    await Bun.sleep(10);
  }

  expect(statuses.at(-1)).toBe(200);

  // full again: a body too large for a notification is refused, and the
  // session's DELETE still gets through
  const filler = await mcp.sendPost({
    jsonrpc: '2.0',
    id: 102,
    method: 'tools/call',
    params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
  });

  await filler.body?.cancel();

  const large = await mcp.sendPost({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 2, reason: 'x'.repeat(20 * 1024) },
  });

  const ended = await mcp.sendDelete();

  expect(large.status).toBe(429);
  expect(ended.status).toBe(204);
}, 30_000);

test('with every slot held, at most 16 bodies are read at once for the allowance', async () => {
  await using ctx = await setupTest();

  const config = ctx.config.publicMcp;

  if (config === null) {
    throw new Error('the public route is off');
  }

  // an MCP endpoint whose calls never end, so 64 of them hold every slot
  const mcp = {
    handle: () => {
      const body = new ReadableStream<Uint8Array>({ start: () => {} });

      return Promise.resolve(new Response(body));
    },
    close: () => Promise.resolve(),
    readCallEnd: () => new Promise<void>(() => {}),
  };

  const handle = createPublicHandler({ config, oauth: ctx.oauth, mcp });

  for (let index = 0; index < 64; index += 1) {
    const response = await handle(
      new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { host: HOST } }),
      null,
    );

    await response.body?.cancel();
  }

  // 33 bodies that never finish; each records whether anything read it
  const reads: boolean[] = [];
  const outcomes: (number | 'waiting')[] = [];

  for (let index = 0; index < 33; index += 1) {
    reads.push(false);

    const body = new ReadableStream<Uint8Array>(
      {
        pull: () => {
          reads[index] = true;

          return new Promise<void>(() => {});
        },
      },
      { highWaterMark: 0 },
    );

    const request = new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: { host: HOST, 'content-type': 'application/json' },
      body,
    });

    outcomes.push('waiting');

    const writeOutcome = async () => {
      const response = await handle(request, null);

      outcomes[index] = response.status;
    };

    void writeOutcome();
  }

  await Bun.sleep(50);

  expect(outcomes.slice(0, 16)).toEqual(Array.from({ length: 16 }, () => 'waiting'));
  expect(outcomes.slice(16)).toEqual(Array.from({ length: 17 }, () => 429));
  expect(reads.slice(16).some(Boolean)).toBeFalse();
});
