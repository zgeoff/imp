import { expect, test } from 'bun:test';
import * as z from 'zod';
import { setupMcpTest } from './test-mcp';

const ProgressSchema = z.object({ method: z.literal('notifications/progress') });
const ImpResultSchema = z.object({ imp: z.object({ name: z.string() }) });

const ToolResultSchema = z.object({
  isError: z.boolean(),
  structuredContent: ImpResultSchema,
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
