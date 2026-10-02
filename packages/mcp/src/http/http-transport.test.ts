import { expect, test } from 'bun:test';
import type { Scope } from '@imp/api';
import * as z from 'zod';
import { createImpGuard } from '../imp-guard';
import { buildFakeClient } from '../test-server';
import { createHttpTransport } from './http-transport';
import type { HttpTransportOptions, McpPrincipal } from './http-transport';

const ToolSchema = z.object({ name: z.string() });
const ToolsListSchema = z.object({ result: z.object({ tools: z.array(ToolSchema) }) });
const URL_BASE = 'http://impd.test/mcp';

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
};

interface RawRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

interface TransportTestOptions {
  readonly listDelayMs?: number;
  readonly keepaliveMs?: number;
  readonly limits?: HttpTransportOptions['limits'];
}

// A transport whose callers are bearer keys: `alice` may manage, `reader`
// may read, and `ends(key)` aborts what a key authenticated with.
function setupTransportTest(options: Readonly<TransportTestOptions> = {}) {
  const clock = { now: 0 };

  const scopes: Readonly<Record<string, Scope>> = {
    alice: 'manage',
    bob: 'manage',
    reader: 'read',
  };

  const ends = new Map<string, AbortController>();

  const client = buildFakeClient(options.listDelayMs ?? 0);

  const transport = createHttpTransport({
    version: '1.2.3',
    progressIntervalMs: 20,
    keepaliveMs: options.keepaliveMs ?? 5000,
    ...(options.limits !== undefined && { limits: options.limits }),
    now: () => clock.now,
    authenticate: (request) => {
      const key = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      const scope = scopes[key];

      if (scope === undefined || ends.get(key)?.signal.aborted === true) {
        return Promise.resolve(null);
      }

      const controller = ends.get(key) ?? new AbortController();

      ends.set(key, controller);

      const principal: McpPrincipal = {
        key,
        scope,
        client,
        guard: createImpGuard({ all: true }),
        ends: controller.signal,
      };

      return Promise.resolve(principal);
    },
  });

  const sendRaw = (init: Readonly<RawRequest>) =>
    transport.handle(new Request(URL_BASE, { ...init, headers: { ...init.headers } }));

  const sendPost = (key: string, body: unknown, headers: Readonly<Record<string, string>> = {}) =>
    sendRaw({
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
    });

  const openSession = async (key: string): Promise<string> => {
    const response = await sendPost(key, INITIALIZE);

    expect(response.status).toBe(200);

    return response.headers.get('mcp-session-id') ?? '';
  };

  const sendInSession = (
    key: string,
    session: string,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ) => sendPost(key, body, { 'mcp-session-id': session, ...headers });

  return {
    clock,
    transport,
    sendRaw,
    sendPost,
    openSession,
    sendInSession,
    endKey: (key: string) => ends.get(key)?.abort(),

    // a new credential for the same caller, as a token made again under its name
    renewKey: (key: string) => ends.delete(key),
    [Symbol.asyncDispose]: () => transport.close(),
  };
}

function readEvents(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line): unknown => JSON.parse(line.slice('data: '.length)));
}

test('initialize opens a session, and its id carries the next requests', async () => {
  await using ctx = setupTransportTest();

  const response = await ctx.sendPost('alice', INITIALIZE);

  const session = response.headers.get('mcp-session-id');

  const body = await response.json();

  expect(response.headers.get('content-type')).toBe('application/json');
  expect(session).toMatch(/^[0-9a-f-]{36}$/);
  expect(body).toMatchObject({ id: 0, result: { protocolVersion: '2025-06-18' } });

  const ping = await ctx.sendInSession('alice', session ?? '', {
    jsonrpc: '2.0',
    id: 1,
    method: 'ping',
  });

  const pong = await ping.json();

  expect(pong).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
});

test('a request outside a session, or in a session not its own, is refused', async () => {
  await using ctx = setupTransportTest();

  const session = await ctx.openSession('alice');

  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

  const none = await ctx.sendPost('alice', ping);
  const unknown = await ctx.sendInSession('alice', crypto.randomUUID(), ping);
  const stranger = await ctx.sendInSession('bob', session, ping);

  const version = await ctx.sendInSession('alice', session, ping, {
    'mcp-protocol-version': '2099-01-01',
  });

  const known = await ctx.sendInSession('alice', session, ping, {
    'mcp-protocol-version': '2025-06-18',
  });

  expect([none.status, unknown.status, stranger.status, version.status, known.status]).toEqual([
    400, 404, 404, 400, 200,
  ]);
});

test('a notification is accepted with 202 and no body', async () => {
  await using ctx = setupTransportTest();

  const session = await ctx.openSession('alice');

  const response = await ctx.sendInSession('alice', session, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  const body = await response.text();

  expect(response.status).toBe(202);
  expect(body).toBe('');
});

test('tools/list shows a read caller only the read tools', async () => {
  await using ctx = setupTransportTest();

  const session = await ctx.openSession('reader');

  const response = await ctx.sendInSession('reader', session, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });

  const json: unknown = await response.json();

  const body = ToolsListSchema.parse(json);

  expect(body.result.tools.map((tool) => tool.name)).toEqual([
    'imp_list',
    'imp_url',
    'imp_image_list',
    'imp_checkpoint_list',
  ]);
});

test('a tool call streams its progress, keepalives and response as SSE', async () => {
  await using ctx = setupTransportTest({ listDelayMs: 120, keepaliveMs: 30 });

  const session = await ctx.openSession('alice');

  const response = await ctx.sendInSession('alice', session, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'imp_list', arguments: {}, _meta: { progressToken: 'p' } },
  });

  expect(response.headers.get('content-type')).toBe('text/event-stream');

  const text = await response.text();

  const events = readEvents(text);

  expect(text).toContain(': keepalive\n\n');

  expect(events.at(0)).toMatchObject({
    method: 'notifications/progress',
    params: { progressToken: 'p', progress: 1 },
  });

  expect(events.at(-1)).toMatchObject({ id: 1, result: { isError: false } });
});

test('a tool call answers as JSON when the client takes no event stream', async () => {
  await using ctx = setupTransportTest({ listDelayMs: 60 });

  const session = await ctx.openSession('alice');

  const response = await ctx.sendInSession(
    'alice',
    session,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {}, _meta: { progressToken: 'p' } },
    },
    { accept: 'application/json' },
  );

  const body = await response.json();

  expect(response.headers.get('content-type')).toBe('application/json');
  expect(body).toMatchObject({ id: 1, result: { structuredContent: { imps: [] } } });
});

test('a cancelled JSON call ends with 202 and no response', async () => {
  await using ctx = setupTransportTest({ listDelayMs: 200 });

  const session = await ctx.openSession('alice');

  const call = ctx.sendInSession(
    'alice',
    session,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'imp_list', arguments: {} } },
    { accept: 'application/json' },
  );

  await Bun.sleep(20);

  const cancel = await ctx.sendInSession('alice', session, {
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 1 },
  });

  const response = await call;

  expect(cancel.status).toBe(202);
  expect(response.status).toBe(202);
});

test('a bad request is refused before it reaches a session', async () => {
  await using ctx = setupTransportTest();

  const nobody = await ctx.sendPost('mallory', INITIALIZE);
  const batch = await ctx.sendPost('alice', [INITIALIZE]);

  const broken = await ctx.sendRaw({
    method: 'POST',
    headers: { authorization: 'Bearer alice', 'content-type': 'application/json' },
    body: '{',
  });

  const plain = await ctx.sendRaw({
    method: 'POST',
    headers: { authorization: 'Bearer alice', 'content-type': 'text/plain' },
    body: JSON.stringify(INITIALIZE),
  });

  const get = await ctx.sendRaw({ method: 'GET', headers: { authorization: 'Bearer alice' } });

  expect([nobody.status, batch.status, broken.status, plain.status, get.status]).toEqual([
    401, 400, 400, 415, 405,
  ]);

  expect(nobody.headers.get('www-authenticate')).toBe('Bearer');
  expect(get.headers.get('allow')).toBe('POST, DELETE');
});

test('a page on another origin is refused, however it says so', async () => {
  await using ctx = setupTransportTest();

  const byOrigin = await ctx.sendPost('alice', INITIALIZE, { origin: 'http://evil.example' });
  const bySite = await ctx.sendPost('alice', INITIALIZE, { 'sec-fetch-site': 'cross-site' });

  const sameOrigin = await ctx.sendPost('alice', INITIALIZE, {
    origin: 'http://impd.test',
    'sec-fetch-site': 'same-origin',
  });

  expect([byOrigin.status, bySite.status, sameOrigin.status]).toEqual([403, 403, 200]);
});

test('DELETE ends a session', async () => {
  await using ctx = setupTransportTest();

  const session = await ctx.openSession('alice');

  const headers = { authorization: 'Bearer alice', 'mcp-session-id': session };

  const ended = await ctx.sendRaw({ method: 'DELETE', headers });
  const again = await ctx.sendRaw({ method: 'DELETE', headers });

  expect([ended.status, again.status]).toEqual([204, 404]);
});

test("a caller's sessions end with what it authenticated with", async () => {
  await using ctx = setupTransportTest();

  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

  const session = await ctx.openSession('alice');
  const bob = await ctx.openSession('bob');

  ctx.endKey('alice');

  const refused = await ctx.sendInSession('alice', session, ping);

  // with a new credential alice is known again, but the old session is gone
  ctx.renewKey('alice');

  const ended = await ctx.sendInSession('alice', session, ping);
  const kept = await ctx.sendInSession('bob', bob, ping);

  expect([refused.status, ended.status, kept.status]).toEqual([401, 404, 200]);
});

test('a full caller evicts its least recently used idle session, and a busy one stays', async () => {
  await using ctx = setupTransportTest({
    listDelayMs: 200,
    limits: { perCaller: 2, total: 3, idleMs: 60_000 },
  });

  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

  const first = await ctx.openSession('alice');

  ctx.clock.now = 1;

  const second = await ctx.openSession('alice');

  ctx.clock.now = 2;

  // a third evicts the first, which was used least recently
  await ctx.openSession('alice');

  const evicted = await ctx.sendInSession('alice', first, ping);
  const kept = await ctx.sendInSession('alice', second, ping);

  expect([evicted.status, kept.status]).toEqual([404, 200]);

  // bob takes the last slot, and a call keeps it busy
  const bob = await ctx.openSession('bob');

  const call = ctx.sendInSession(
    'bob',
    bob,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'imp_list', arguments: {} } },
    { accept: 'application/json' },
  );

  await Bun.sleep(20);

  // the store is full: a new reader evicts alice's idle session, never bob's busy one
  const reader = await ctx.sendPost('reader', INITIALIZE);
  const answered = await call;

  expect([reader.status, answered.status]).toEqual([200, 200]);
});

test('a caller with only busy sessions gets 429', async () => {
  await using ctx = setupTransportTest({
    listDelayMs: 200,
    limits: { perCaller: 1, total: 4, idleMs: 60_000 },
  });

  const session = await ctx.openSession('alice');

  const call = ctx.sendInSession(
    'alice',
    session,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'imp_list', arguments: {} } },
    { accept: 'application/json' },
  );

  await Bun.sleep(20);

  const refused = await ctx.sendPost('alice', INITIALIZE);
  const answered = await call;

  expect([refused.status, answered.status]).toEqual([429, 200]);
});

test('an idle session ends after the idle limit', async () => {
  await using ctx = setupTransportTest({ limits: { perCaller: 4, total: 4, idleMs: 1000 } });

  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

  const session = await ctx.openSession('alice');

  ctx.clock.now = 1000;

  const fresh = await ctx.sendInSession('alice', session, ping);

  ctx.clock.now = 2001;

  const stale = await ctx.sendInSession('alice', session, ping);

  expect([fresh.status, stale.status]).toEqual([200, 404]);
});
