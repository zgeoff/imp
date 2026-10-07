import { expect, onTestFinished, test } from 'bun:test';
import { impContract } from '@imp/api';
import type { Imp } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { server } from '@imp/test-utils/mock-server';
import { implement } from '@orpc/server';
import { createImpClient } from '@zgeoff/imp-client';
import * as z from 'zod';
import { buildMockMcpPrincipal } from '../test-utils/build-mock-mcp-principal';
import { buildStubImpd } from '../test-utils/build-stub-impd';
import { buildStubRepeat } from '../test-utils/build-stub-repeat';
import { createHttpTransport } from './http-transport';
import type { McpPrincipal } from './http-transport';

// A transport whose callers are the principals a test adds, by the
// Authorization header they send; its timers run only when the test ticks
// them, and its clock reads `clock.now`.
// oxlint-disable-next-line require-await -- `await using` awaits the stack's disposal when setup throws
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const timer = buildStubRepeat();
  const clock = { now: 0 };

  const principals = new Map<string, McpPrincipal>();

  // impd's API as the tools reach it; a test stubs impd at this address
  const client = createImpClient({ url: 'http://impd.test' });

  const readPrincipal = (request: Request) =>
    Promise.resolve(principals.get(request.headers.get('authorization') ?? '') ?? null);

  const transport = createHttpTransport({
    // the server's version, which no test that uses this transport reads
    version: '0.0.0',
    repeat: timer.repeat,
    now: () => clock.now,
    authenticate: readPrincipal,

    // impd decides from Origin and Sec-Fetch-Site; here, a header says so
    isCrossOrigin: (request) => request.headers.has('x-cross-origin'),
  });

  stack.defer(() => transport.close());

  const owned = stack.move();

  return {
    timer,
    clock,
    principals,
    client,
    readPrincipal,
    transport,

    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it opens a session at initialize and answers with its id', async () => {
  await using ctx = await setupTest();

  const transport = createHttpTransport({
    version: '1.2.3',
    repeat: ctx.timer.repeat,
    authenticate: ctx.readPrincipal,
    isCrossOrigin: (request) => request.headers.has('x-cross-origin'),
  });

  onTestFinished(() => transport.close());

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const response = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(response.headers.get('mcp-session-id')).toMatch(/^[0-9a-f-]{36}$/);

  expect(body).toStrictEqual({
    jsonrpc: '2.0',
    id: 0,
    result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'imp', title: 'imp', version: '1.2.3' },
      instructions: expect.any(String) as unknown,
    },
  });
});

test('it answers a request in the session that initialize opened', async () => {
  await using ctx = await setupTest();

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const opened = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({ jsonrpc: '2.0', id: 1, result: {} });
});

test('it refuses a request outside a session with 400', async () => {
  await using ctx = await setupTest();

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(400);

  expect(body).toStrictEqual({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32_000, message: 'no mcp-session-id: initialize first' },
  });
});

test('it refuses a request in an unknown session with 404', async () => {
  await using ctx = await setupTest();

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': '00000000-0000-4000-8000-000000000000',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
  );

  const body = await response.text();

  expect(response.status).toBe(404);
  expect(body).toBe('no such MCP session\n');
});

test("it refuses a request in another caller's session with 404", async () => {
  await using ctx = await setupTest();

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));
  ctx.principals.set('Bearer bob', buildMockMcpPrincipal({ key: 'bob', client: ctx.client }));

  const opened = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bob',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
  );

  expect(response.status).toBe(404);
});

test('it refuses a protocol version header it does not support with 400', async () => {
  await using ctx = await setupTest();

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const opened = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session,
        'mcp-protocol-version': '2099-01-01',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
  );

  const body = await response.text();

  expect(response.status).toBe(400);
  expect(body).toBe('unsupported mcp-protocol-version: 2099-01-01\n');
});

test('it answers a request that names a protocol version it supports', async () => {
  await using ctx = await setupTest();

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const opened = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session,
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
  );

  expect(response.status).toBe(200);
});

test('it accepts a notification with 202 and no body', async () => {
  await using ctx = await setupTest();

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const opened = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }),
  );

  const body = await response.text();

  expect(response.status).toBe(202);
  expect(body).toBe('');
});

test('it lists only the read tools to a read caller', async () => {
  await using ctx = await setupTest();

  ctx.principals.set(
    'Bearer reader',
    buildMockMcpPrincipal({ key: 'reader', scope: 'read', client: ctx.client }),
  );

  const opened = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer reader',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer reader',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
  );

  const json: unknown = await response.json();

  const Tool = z.object({ name: z.string() });
  const body = z.object({ result: z.object({ tools: z.array(Tool) }) }).parse(json);

  expect(body.result.tools.map((tool) => tool.name)).toStrictEqual([
    'imp_list',
    'imp_url',
    'imp_image_list',
    'imp_checkpoint_list',
  ]);
});

test('it streams a tool call’s progress, keepalives and response as server-sent events', async () => {
  await using ctx = await setupTest();

  const transport = createHttpTransport({
    version: '1.2.3',
    progressIntervalMs: 20,
    keepaliveMs: 30,
    repeat: ctx.timer.repeat,
    authenticate: ctx.readPrincipal,
    isCrossOrigin: (request) => request.headers.has('x-cross-origin'),
  });

  onTestFinished(() => transport.close());

  const impd = implement(impContract);
  const listed = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<Imp[]>();

  server.use(
    buildStubImpd('http://impd.test', {
      imps: {
        list: impd.imps.list.handler(() => {
          listed.resolve();

          return answer.promise;
        }),
      },
    }),
  );

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const opened = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'imp_list', arguments: {}, _meta: { progressToken: 'p' } },
      }),
    }),
  );

  await listed.promise;

  ctx.timer.tick(20);
  ctx.timer.tick(30);
  answer.resolve([]);

  const text = await response.text();

  expect(response.headers.get('content-type')).toBe('text/event-stream');

  const blocks: unknown[] = text.split('\n\n');

  expect(blocks).toStrictEqual([
    expect.stringMatching(
      /^event: message\ndata: \{.*"method":"notifications\/progress".*\}$/,
    ) as unknown,
    ': keepalive',
    expect.stringMatching(/^event: message\ndata: \{.*"id":1,"result":.*\}$/) as unknown,
    '',
  ]);

  expect(
    text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line): unknown => JSON.parse(line.slice('data: '.length))),
  ).toStrictEqual([
    {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: 'p',
        progress: 1,
        message: expect.stringMatching(/^still running after \d+ s$/) as unknown,
      },
    },
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: '{\n  "imps": []\n}' }],
        structuredContent: { imps: [] },
        isError: false,
      },
    },
  ]);
});

test('it ends a call only once impd answers, after its stream drops', async () => {
  await using ctx = await setupTest();

  const impd = implement(impContract);
  const listed = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<Imp[]>();
  const state = { ended: false };

  server.use(
    buildStubImpd('http://impd.test', {
      imps: {
        list: impd.imps.list.handler(() => {
          listed.resolve();

          return answer.promise;
        }),
      },
    }),
  );

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const opened = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'imp_list', arguments: {} },
      }),
    }),
  );

  const callEnd = ctx.transport.readCallEnd(response);

  invariant(callEnd);
  invariant(response.body);

  const tracked = (async () => {
    await callEnd;

    state.ended = true;
  })();

  await response.body.cancel();

  await listed.promise;

  // a full round trip through the same session: any cancel the drop set off
  // has run by the time it answers
  const ping = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-session-id': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    }),
  );

  const endedBeforeAnswer = state.ended;

  answer.resolve([]);

  await expect(tracked).toResolve();

  expect(ping.status).toBe(200);
  expect(endedBeforeAnswer).toBeFalse();
});

test('it knows no call end for a response that is not a streamed call', () => {
  const transport = createHttpTransport({
    version: '1.2.3',
    authenticate: () => Promise.resolve(null),
    isCrossOrigin: () => false,
  });

  onTestFinished(() => transport.close());

  expect(transport.readCallEnd(new Response('x'))).toBeNull();
});

test('it answers a tool call as JSON, without its progress, when the client takes no event stream', async () => {
  await using ctx = await setupTest();

  const transport = createHttpTransport({
    version: '1.2.3',
    progressIntervalMs: 20,
    keepaliveMs: 30,
    repeat: ctx.timer.repeat,
    authenticate: ctx.readPrincipal,
    isCrossOrigin: (request) => request.headers.has('x-cross-origin'),
  });

  onTestFinished(() => transport.close());

  const impd = implement(impContract);
  const listed = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<Imp[]>();

  server.use(
    buildStubImpd('http://impd.test', {
      imps: {
        list: impd.imps.list.handler(() => {
          listed.resolve();

          return answer.promise;
        }),
      },
    }),
  );

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const opened = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const call = transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        'mcp-session-id': session,
        accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'imp_list', arguments: {}, _meta: { progressToken: 'p' } },
      }),
    }),
  );

  await listed.promise;

  ctx.timer.tick(20);
  answer.resolve([]);

  const response = await call;
  const body: unknown = await response.json();

  expect(response.headers.get('content-type')).toBe('application/json');

  expect(body).toStrictEqual({
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: '{\n  "imps": []\n}' }],
      structuredContent: { imps: [] },
      isError: false,
    },
  });
});

test('it ends a cancelled JSON call with 202 and no response', async () => {
  await using ctx = await setupTest();

  const impd = implement(impContract);
  const listed = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<Imp[]>();

  server.use(
    buildStubImpd('http://impd.test', {
      imps: {
        list: impd.imps.list.handler(() => {
          listed.resolve();

          return answer.promise;
        }),
      },
    }),
  );

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const opened = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const call = ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        'mcp-session-id': session,
        accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'imp_list', arguments: {} },
      }),
    }),
  );

  await listed.promise;

  const cancel = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 1 },
      }),
    }),
  );

  answer.resolve([]);

  const response = await call;
  const body = await response.text();

  expect(cancel.status).toBe(202);
  expect(response.status).toBe(202);
  expect(body).toBe('');
});

test('it refuses an unknown caller with 401 and a bearer challenge', async () => {
  await using ctx = await setupTest();

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer mallory',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toBe('Bearer');
});

test('it refuses a batch of messages with 400', async () => {
  await using ctx = await setupTest();

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify([
        {
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
        },
      ]),
    }),
  );

  expect(response.status).toBe(400);
});

test('it refuses a body that is not JSON with 400 and a parse error', async () => {
  await using ctx = await setupTest();

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer alice', 'content-type': 'application/json' },
      body: '{',
    }),
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(400);

  expect(body).toStrictEqual({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32_700, message: 'parse error: not JSON' },
  });
});

test('it refuses a POST that is not application/json with 415', async () => {
  await using ctx = await setupTest();

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer alice', 'content-type': 'text/plain' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
  );

  expect(response.status).toBe(415);
});

test('it refuses a GET with 405 and names the methods it allows', async () => {
  await using ctx = await setupTest();

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'GET',
      headers: { authorization: 'Bearer alice' },
    }),
  );

  expect(response.status).toBe(405);
  expect(response.headers.get('allow')).toBe('POST, DELETE');
});

test('it refuses a page on another origin with 403 before it authenticates', async () => {
  await using ctx = await setupTest();

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer mallory',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-cross-origin': '1',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  expect(response.status).toBe(403);
});

test('it ends a session on DELETE', async () => {
  await using ctx = await setupTest();

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const opened = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const ended = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'DELETE',
      headers: { authorization: 'Bearer alice', 'mcp-session-id': session },
    }),
  );

  const after = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
  );

  expect(ended.status).toBe(204);
  expect(after.status).toBe(404);
});

test('it refuses a DELETE of an unknown session with 404', async () => {
  await using ctx = await setupTest();

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'DELETE',
      headers: {
        authorization: 'Bearer alice',
        'mcp-session-id': '00000000-0000-4000-8000-000000000000',
      },
    }),
  );

  expect(response.status).toBe(404);
});

test('it ends a caller’s sessions when what it authenticated with ends', async () => {
  await using ctx = await setupTest();

  const ends = new AbortController();

  ctx.principals.set(
    'Bearer alice',
    buildMockMcpPrincipal({ key: 'alice', client: ctx.client, ends: ends.signal }),
  );

  const opened = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  ends.abort();

  // a new credential for the same caller, as a token made again under its name
  ctx.principals.set(
    'Bearer alice',
    buildMockMcpPrincipal({ key: 'alice', client: ctx.client, ends: new AbortController().signal }),
  );

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
  );

  expect(response.status).toBe(404);
});

test('it keeps another caller’s session when one caller’s credential ends', async () => {
  await using ctx = await setupTest();

  const ends = new AbortController();

  ctx.principals.set(
    'Bearer alice',
    buildMockMcpPrincipal({ key: 'alice', client: ctx.client, ends: ends.signal }),
  );

  ctx.principals.set(
    'Bearer bob',
    buildMockMcpPrincipal({ key: 'bob', client: ctx.client, ends: new AbortController().signal }),
  );

  await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const opened = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bob',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  ends.abort();

  const response = await ctx.transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bob',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
  );

  expect(response.status).toBe(200);
});

test('it evicts the least recently used idle session of a caller at its limit', async () => {
  await using ctx = await setupTest();

  const transport = createHttpTransport({
    version: '1.2.3',
    limits: { perCaller: 2, total: 3, idleMs: 60_000 },
    repeat: ctx.timer.repeat,
    now: () => ctx.clock.now,
    authenticate: ctx.readPrincipal,
    isCrossOrigin: (request) => request.headers.has('x-cross-origin'),
  });

  onTestFinished(() => transport.close());

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const first = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  ctx.clock.now = 1;

  const second = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  ctx.clock.now = 2;

  const firstSession = first.headers.get('mcp-session-id');
  const secondSession = second.headers.get('mcp-session-id');

  invariant(firstSession);
  invariant(secondSession);

  await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const evicted = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': firstSession,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
  );

  const kept = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': secondSession,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
  );

  expect(evicted.status).toBe(404);
  expect(kept.status).toBe(200);
});

test('it evicts an idle session, never a busy one, when the store is full', async () => {
  await using ctx = await setupTest();

  const impd = implement(impContract);
  const listed = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<Imp[]>();

  const transport = createHttpTransport({
    version: '1.2.3',
    limits: { perCaller: 2, total: 2, idleMs: 60_000 },
    repeat: ctx.timer.repeat,
    now: () => ctx.clock.now,
    authenticate: ctx.readPrincipal,
    isCrossOrigin: (request) => request.headers.has('x-cross-origin'),
  });

  onTestFinished(() => transport.close());

  server.use(
    buildStubImpd('http://impd.test', {
      imps: {
        list: impd.imps.list.handler(() => {
          listed.resolve();

          return answer.promise;
        }),
      },
    }),
  );

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));
  ctx.principals.set('Bearer bob', buildMockMcpPrincipal({ key: 'bob', client: ctx.client }));

  ctx.principals.set(
    'Bearer reader',
    buildMockMcpPrincipal({ key: 'reader', scope: 'read', client: ctx.client }),
  );

  // bob's session is the older one, and busy with a call
  const bobOpened = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bob',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const bobSession = bobOpened.headers.get('mcp-session-id');

  invariant(bobSession);

  const call = transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer bob',
        'content-type': 'application/json',
        'mcp-session-id': bobSession,
        accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'imp_list', arguments: {} },
      }),
    }),
  );

  await listed.promise;

  ctx.clock.now = 1;

  const aliceOpened = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const aliceSession = aliceOpened.headers.get('mcp-session-id');

  invariant(aliceSession);

  ctx.clock.now = 2;

  const reader = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer reader',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  answer.resolve([]);

  const answered = await call;

  const alice = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': aliceSession,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
  );

  expect(reader.status).toBe(200);
  expect(answered.status).toBe(200);
  expect(alice.status).toBe(404);
});

test('it refuses a new session with 429 to a caller whose sessions are all busy', async () => {
  await using ctx = await setupTest();

  const impd = implement(impContract);
  const listed = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<Imp[]>();

  const transport = createHttpTransport({
    version: '1.2.3',
    limits: { perCaller: 1, total: 4, idleMs: 60_000 },
    repeat: ctx.timer.repeat,
    now: () => ctx.clock.now,
    authenticate: ctx.readPrincipal,
    isCrossOrigin: (request) => request.headers.has('x-cross-origin'),
  });

  onTestFinished(() => transport.close());

  server.use(
    buildStubImpd('http://impd.test', {
      imps: {
        list: impd.imps.list.handler(() => {
          listed.resolve();

          return answer.promise;
        }),
      },
    }),
  );

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const opened = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  const call = transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        'mcp-session-id': session,
        accept: 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'imp_list', arguments: {} },
      }),
    }),
  );

  await listed.promise;

  const refused = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const body = await refused.text();

  answer.resolve([]);

  const answered = await call;

  expect(refused.status).toBe(429);
  expect(answered.status).toBe(200);
  expect(body).toBe('too many MCP sessions: end one with a DELETE first\n');
});

test('it keeps a session used within the idle limit', async () => {
  await using ctx = await setupTest();

  const transport = createHttpTransport({
    version: '1.2.3',
    limits: { perCaller: 4, total: 4, idleMs: 1000 },
    repeat: ctx.timer.repeat,
    now: () => ctx.clock.now,
    authenticate: ctx.readPrincipal,
    isCrossOrigin: (request) => request.headers.has('x-cross-origin'),
  });

  onTestFinished(() => transport.close());

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const opened = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  ctx.clock.now = 1000;

  const response = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
  );

  expect(response.status).toBe(200);
});

test('it ends a session idle past the idle limit', async () => {
  await using ctx = await setupTest();

  const transport = createHttpTransport({
    version: '1.2.3',
    limits: { perCaller: 4, total: 4, idleMs: 1000 },
    repeat: ctx.timer.repeat,
    now: () => ctx.clock.now,
    authenticate: ctx.readPrincipal,
    isCrossOrigin: (request) => request.headers.has('x-cross-origin'),
  });

  onTestFinished(() => transport.close());

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const opened = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  ctx.clock.now = 1001;

  const response = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
  );

  expect(response.status).toBe(404);
});

test('it restarts the idle clock of a session each time it is used', async () => {
  await using ctx = await setupTest();

  const transport = createHttpTransport({
    version: '1.2.3',
    limits: { perCaller: 4, total: 4, idleMs: 1000 },
    repeat: ctx.timer.repeat,
    now: () => ctx.clock.now,
    authenticate: ctx.readPrincipal,
    isCrossOrigin: (request) => request.headers.has('x-cross-origin'),
  });

  onTestFinished(() => transport.close());

  ctx.principals.set('Bearer alice', buildMockMcpPrincipal({ key: 'alice', client: ctx.client }));

  const opened = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
      }),
    }),
  );

  const session = opened.headers.get('mcp-session-id');

  invariant(session);

  ctx.clock.now = 1000;

  await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }),
  );

  ctx.clock.now = 2000;

  const response = await transport.handle(
    new Request('http://impd.test/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alice',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    }),
  );

  expect(response.status).toBe(200);
});
