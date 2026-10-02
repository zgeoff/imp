import { expect, test } from 'bun:test';
import * as z from 'zod';
import { INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR } from './json-rpc';
import { PROTOCOL_VERSIONS } from './mcp-server';
import { setupMcpTest } from './test-mcp';

const InitializeResultSchema = z.looseObject({ instructions: z.string() });
const AnnotationsSchema = z.object({ destructiveHint: z.boolean().optional() });
const PropertySchema = z.object({ description: z.string().optional() });

const InputSchemaSchema = z.object({
  type: z.string(),
  properties: z.record(z.string(), PropertySchema).optional(),
});

const ToolSchema = z.object({
  name: z.string(),
  annotations: AnnotationsSchema,
  inputSchema: InputSchemaSchema,
});

const ToolsListSchema = z.object({ tools: z.array(ToolSchema) });
const ProgressSchema = z.object({ method: z.literal('notifications/progress') });
const ImpResultSchema = z.object({ imp: z.object({ name: z.string() }) });

const ToolResultSchema = z.object({
  isError: z.boolean(),
  structuredContent: ImpResultSchema,
});

test('initialize agrees on a version the server supports, else offers the newest', async () => {
  await using ctx = await setupMcpTest({ guard: { prefix: 'agent-' } });

  for (const version of PROTOCOL_VERSIONS) {
    const response = await ctx.sendRequest('initialize', { protocolVersion: version });

    expect(response?.result).toMatchObject({ protocolVersion: version });
  }

  const unknown = await ctx.sendRequest('initialize', { protocolVersion: '2024-11-05' });

  const result = InitializeResultSchema.parse(unknown?.result);

  expect(result).toMatchObject({
    protocolVersion: '2025-11-25',
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'imp', title: 'imp', version: '1.2.3' },
  });

  expect(result.instructions).toContain('This server may touch imps named agent-*.');
});

test('tools/list describes every tool, every field and the destructive ones', async () => {
  await using ctx = await setupMcpTest();

  const response = await ctx.sendRequest('tools/list');

  const tools = ToolsListSchema.parse(response?.result).tools;

  expect(tools.map((tool) => tool.name)).toEqual([
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

  const destructive = tools
    .filter((tool) => tool.annotations.destructiveHint === true)
    .map((tool) => tool.name);

  expect(destructive).toEqual([
    'imp_destroy',
    'imp_exec',
    'imp_write_file',
    'imp_restore',
    'imp_checkpoint_delete',
  ]);

  for (const tool of tools) {
    const schema = tool.inputSchema;

    expect(schema.type).toBe('object');

    for (const [field, property] of Object.entries(schema.properties ?? {})) {
      expect({ tool: tool.name, field, described: typeof property.description }).toEqual({
        tool: tool.name,
        field,
        described: 'string',
      });
    }
  }
});

test('ping answers with an empty result', async () => {
  await using ctx = await setupMcpTest();

  const response = await ctx.sendRequest('ping');

  expect(response?.result).toEqual({});
});

test('an unknown method and an unknown tool are protocol errors', async () => {
  await using ctx = await setupMcpTest();

  const method = await ctx.sendRequest('resources/list');
  const tool = await ctx.sendRequest('tools/call', { name: 'imp_teleport', arguments: {} });

  expect(method?.error).toMatchObject({ code: METHOD_NOT_FOUND });

  expect(tool?.error).toMatchObject({
    code: INVALID_PARAMS,
    message: 'unknown tool: imp_teleport',
  });
});

test('broken messages get an error with a null id, and notifications get nothing', async () => {
  await using ctx = await setupMcpTest();

  for (const line of [
    'not json',
    '[{"jsonrpc":"2.0","id":1,"method":"ping"}]',
    '{"jsonrpc":"1.0","id":1,"method":"ping"}',
    '{"jsonrpc":"2.0","id":1}',
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":5,"result":{}}',
  ]) {
    await ctx.mcp.receive(line);
  }

  expect(ctx.sent).toEqual([
    { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'parse error: not JSON' } },
    { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'invalid request' } },
    { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'invalid request' } },
    { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'invalid request' } },
  ]);
});

test('a cancelled create, fork or restore still answers, so the agent learns what it made', async () => {
  await using ctx = await setupMcpTest({ guard: { prefix: 'agent-' } });

  await ctx.client.imps.create({ name: 'agent-src', image: 'ubuntu' });
  await ctx.client.checkpoints.create({ name: 'agent-src', label: 'cp' });

  const calls = [
    { name: 'imp_create', arguments: { image: 'ubuntu' } },
    { name: 'imp_fork', arguments: { source: 'agent-src' } },
    { name: 'imp_restore', arguments: { name: 'agent-src', checkpoint: 'cp' } },
  ];

  for (const [index, params] of calls.entries()) {
    const id = 100 + index;
    const call = ctx.sendRequest('tools/call', params, id);

    await ctx.mcp.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: id },
      }),
    );

    const response = await call;

    const result = ToolResultSchema.parse(response?.result);

    expect({ tool: params.name, isError: result.isError }).toEqual({
      tool: params.name,
      isError: false,
    });

    expect(result.structuredContent.imp.name).toStartWith('agent-');
  }
});

test('a cancelled call stops reporting progress', async () => {
  await using ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const call = ctx.sendRequest(
    'tools/call',
    {
      name: 'imp_exec',
      arguments: { name: 'dev', command: 'stubborn' },
      _meta: { progressToken: 'p' },
    },
    9,
  );

  await Bun.sleep(120);

  await ctx.mcp.receive(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }),
  );

  const atCancel = countProgress(ctx.sent);

  await call;

  expect(atCancel).toBeGreaterThan(0);
  expect(countProgress(ctx.sent)).toBe(atCancel);
});

function countProgress(sent: readonly unknown[]): number {
  return sent.filter((message) => ProgressSchema.safeParse(message).success).length;
}
