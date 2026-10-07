import { expect, test } from 'bun:test';
import { createImpClient } from '@zgeoff/imp-client';
import * as z from 'zod';
import { createImpGuard } from './imp-guard';
import { INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR } from './json-rpc';
import { createMcpServer } from './mcp-server';

// The server's replies, parsed. The context needs a client, though no test
// here makes a call that reaches impd.
function setupTest() {
  const sent: unknown[] = [];

  return {
    sent,
    reply: (message: string) => {
      sent.push(JSON.parse(message));
    },
    client: createImpClient({ url: 'http://impd.test' }),
  };
}

test.each([['2025-11-25'], ['2025-06-18'], ['2025-03-26']])(
  'it agrees on the protocol version %s',
  async (version) => {
    const ctx = setupTest();
    const server = createMcpServer({ version: '1.2.3' });

    await server.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: version },
      }),
      {
        reply: ctx.reply,
        client: ctx.client,
        guard: createImpGuard({ all: true }),
        scope: 'manage',
      },
    );

    expect(ctx.sent).toStrictEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'imp', title: 'imp', version: '1.2.3' },
          instructions: expect.any(String) as unknown,
        },
      },
    ]);
  },
);

test('it offers the newest protocol version for one it does not support', async () => {
  const ctx = setupTest();
  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    }),
    { reply: ctx.reply, client: ctx.client, guard: createImpGuard({ all: true }), scope: 'manage' },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'imp', title: 'imp', version: '1.2.3' },
        instructions: expect.any(String) as unknown,
      },
    },
  ]);
});

test('it names the guard in the instructions it gives at initialize', async () => {
  const ctx = setupTest();
  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    }),
    {
      reply: ctx.reply,
      client: ctx.client,
      guard: createImpGuard({ prefix: 'agent-' }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: expect.objectContaining({
        instructions: expect.stringContaining(
          'This server may touch imps named agent-*.',
        ) as unknown,
      }) as unknown,
    },
  ]);
});

test('it lists every tool to a manage caller', async () => {
  const ctx = setupTest();
  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  const Tool = z.object({ name: z.string() });

  const tools = z.object({ result: z.object({ tools: z.array(Tool) }) }).parse(ctx.sent[0])
    .result.tools;

  expect(tools.map((tool) => tool.name)).toStrictEqual([
    'imp_list',
    'imp_create',
    'imp_destroy',
    'imp_sleep',
    'imp_url',
    'imp_fork',
    'imp_image_list',
    'imp_exec',
    'imp_read_file',
    'imp_write_file',
    'imp_checkpoint',
    'imp_checkpoint_list',
    'imp_restore',
    'imp_checkpoint_delete',
  ]);
});

test('it marks the destructive tools with a destructive hint', async () => {
  const ctx = setupTest();
  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  const Annotations = z.object({ destructiveHint: z.boolean().optional() });
  const Tool = z.object({ name: z.string(), annotations: Annotations });

  const tools = z.object({ result: z.object({ tools: z.array(Tool) }) }).parse(ctx.sent[0])
    .result.tools;

  expect(
    tools.filter((tool) => tool.annotations.destructiveHint === true).map((tool) => tool.name),
  ).toStrictEqual([
    'imp_destroy',
    'imp_exec',
    'imp_write_file',
    'imp_restore',
    'imp_checkpoint_delete',
  ]);
});

test('it gives every tool an object input schema', async () => {
  const ctx = setupTest();
  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  const Tool = z.object({ inputSchema: z.object({ type: z.string() }) });

  const tools = z.object({ result: z.object({ tools: z.array(Tool) }) }).parse(ctx.sent[0])
    .result.tools;

  expect(tools).toSatisfyAll((tool: (typeof tools)[number]) => tool.inputSchema.type === 'object');
});

test('it describes every input field of every tool', async () => {
  const ctx = setupTest();
  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  const Property = z.object({ description: z.string().optional() });
  const InputSchema = z.object({ properties: z.record(z.string(), Property).optional() });
  const Tool = z.object({ name: z.string(), inputSchema: InputSchema });

  const tools = z.object({ result: z.object({ tools: z.array(Tool) }) }).parse(ctx.sent[0])
    .result.tools;

  const undescribed = tools.flatMap((tool) =>
    Object.entries(tool.inputSchema.properties ?? {})
      .filter(([, property]) => property.description === undefined)
      .map(([field]) => `${tool.name}.${field}`),
  );

  expect(undescribed).toBeEmpty();
});

test('it answers ping with an empty result', async () => {
  const ctx = setupTest();
  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  expect(ctx.sent).toStrictEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
});

test('it answers an unknown method with a method-not-found error', async () => {
  const ctx = setupTest();
  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/list' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      error: { code: METHOD_NOT_FOUND, message: 'unknown method: resources/list' },
    },
  ]);
});

test('it answers a call of an unknown tool with an invalid-params error', async () => {
  const ctx = setupTest();
  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_teleport', arguments: {} },
    }),
    { reply: ctx.reply, client: ctx.client, guard: createImpGuard({ all: true }), scope: 'manage' },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      error: { code: INVALID_PARAMS, message: 'unknown tool: imp_teleport' },
    },
  ]);
});

test('it answers a line that is not JSON with a parse error and a null id', async () => {
  const ctx = setupTest();
  const server = createMcpServer({ version: '1.2.3' });

  await server.receive('not json', {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  expect(ctx.sent).toStrictEqual([
    { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'parse error: not JSON' } },
  ]);
});

test.each([
  ['[{"jsonrpc":"2.0","id":1,"method":"ping"}]'],
  ['{"jsonrpc":"1.0","id":1,"method":"ping"}'],
  ['{"jsonrpc":"2.0","id":1}'],
])('it answers the invalid request %s with an error and a null id', async (line) => {
  const ctx = setupTest();
  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(line, {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  expect(ctx.sent).toStrictEqual([
    { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'invalid request' } },
  ]);
});

test.each([
  ['{"jsonrpc":"2.0","method":"notifications/initialized"}'],
  ['{"jsonrpc":"2.0","id":5,"result":{}}'],
])('it sends nothing for the message %s', async (line) => {
  const ctx = setupTest();
  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(line, {
    reply: ctx.reply,
    client: ctx.client,
    guard: createImpGuard({ all: true }),
    scope: 'manage',
  });

  expect(ctx.sent).toBeEmpty();
});
