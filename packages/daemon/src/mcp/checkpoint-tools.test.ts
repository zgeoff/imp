import { expect, test } from 'bun:test';
import { setupMcpTest } from './test-mcp';

test('checkpoint, list, restore and delete work on a running, sleeping and stopped imp', async () => {
  await using ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'awake', image: 'ubuntu' });
  await ctx.client.imps.create({ name: 'asleep', image: 'ubuntu' });
  await ctx.client.imps.create({ name: 'off', image: 'ubuntu' });
  await ctx.client.imps.sleep({ name: 'asleep' });
  await ctx.client.imps.stop({ name: 'off' });

  for (const name of ['awake', 'asleep', 'off']) {
    const taken = await ctx.runTool('imp_checkpoint', { name, label: 'cp1' });

    expect(taken.isError).toBe(false);

    const listed = await ctx.runTool('imp_checkpoint_list', { name });

    expect(listed.structuredContent).toMatchObject({ checkpoints: [{ label: 'cp1' }] });

    const restored = await ctx.runTool('imp_restore', { name, checkpoint: 'cp1' });

    expect(restored.structuredContent).toMatchObject({ imp: { name } });

    const deleted = await ctx.runTool('imp_checkpoint_delete', { name, checkpoint: 'cp1' });

    expect(deleted.structuredContent).toEqual({ deleted: 'cp1' });

    const after = await ctx.client.checkpoints.list({ name });

    expect(after).toEqual([]);
  }
});

test('a restore to a checkpoint that does not exist is an isError result', async () => {
  await using ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const restored = await ctx.runTool('imp_restore', { name: 'dev', checkpoint: 'nope' });

  expect(restored.isError).toBe(true);
  expect(restored.content[0].text).toStartWith('NOT_FOUND: ');
});
