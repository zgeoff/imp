import { expect, test } from 'bun:test';
import { setupMcpTest } from '../test-mcp';

test('imp_create boots an imp and imp_list shows it with its state', async () => {
  await using ctx = await setupMcpTest();

  const created = await ctx.runTool('imp_create', { name: 'dev', image: 'ubuntu' });

  expect(created.isError).toBe(false);

  expect(created.structuredContent).toMatchObject({
    imp: { name: 'dev', image: 'ubuntu', state: 'running' },
  });

  const listed = await ctx.runTool('imp_list');

  expect(listed.structuredContent).toMatchObject({ imps: [{ name: 'dev', state: 'running' }] });

  // the text is the structured content as JSON, dates as ISO strings
  expect(JSON.parse(listed.content[0].text)).toEqual(listed.structuredContent);
});

test('the guard hides other imps and refuses them before impd is called', async () => {
  await using ctx = await setupMcpTest({ guard: { prefix: 'agent-' } });

  await ctx.client.imps.create({ name: 'prod', image: 'ubuntu' });
  await ctx.client.imps.create({ name: 'agent-one', image: 'ubuntu' });

  const listed = await ctx.runTool('imp_list');

  expect(listed.structuredContent).toMatchObject({ imps: [{ name: 'agent-one' }] });

  for (const [tool, args] of [
    ['imp_destroy', { name: 'prod' }],
    ['imp_restore', { name: 'prod', checkpoint: 'x' }],
    ['imp_exec', { name: 'prod', command: 'echo hi' }],
    ['imp_write_file', { name: 'prod', path: '/x', content: 'x' }],
    ['imp_fork', { source: 'prod', name: 'agent-two' }],
    ['imp_fork', { source: 'agent-one', name: 'other' }],
    ['imp_create', { name: 'other' }],
  ] as const) {
    const refused = await ctx.runTool(tool, args);

    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toStartWith('GUARD: ');
  }

  const remaining = await ctx.client.imps.list();

  expect(remaining.map((imp) => imp.name).toSorted()).toEqual(['agent-one', 'prod']);
  expect(ctx.guest.requests).toEqual([]);
});

test('imp_create without a name picks one under the prefix', async () => {
  await using ctx = await setupMcpTest({ guard: { prefix: 'agent-' } });

  const created = await ctx.runTool('imp_create', { image: 'ubuntu' });
  const imps = await ctx.client.imps.list();

  const name = imps[0]?.name;

  expect(imps).toHaveLength(1);
  expect(name).toMatch(/^agent-[a-z0-9]{8}$/);
  expect(created.structuredContent).toMatchObject({ imp: { name } });
});

test('an allow-list alone needs an explicit name to create', async () => {
  await using ctx = await setupMcpTest({ guard: { allow: ['box'] } });

  const unnamed = await ctx.runTool('imp_create', { image: 'ubuntu' });

  expect(unnamed).toMatchObject({ isError: true });
  expect(unnamed.content[0].text).toBe('GUARD: give a name: the imps box');

  const named = await ctx.runTool('imp_create', { name: 'box', image: 'ubuntu' });

  expect(named.isError).toBe(false);
});

test('imp_sleep, imp_url and imp_destroy act on the imp', async () => {
  await using ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const slept = await ctx.runTool('imp_sleep', { name: 'dev' });

  expect(slept.structuredContent).toMatchObject({ imp: { state: 'sleeping' } });

  const urls = await ctx.runTool('imp_url', { name: 'dev' });

  const local = String(urls.structuredContent?.['local']);

  expect(local).toContain('dev.');
  expect(urls.structuredContent?.['tailnet']).toBeNull();

  const destroyed = await ctx.runTool('imp_destroy', { name: 'dev' });
  const remaining = await ctx.client.imps.list();

  expect(destroyed.structuredContent).toEqual({ destroyed: 'dev' });
  expect(remaining).toEqual([]);
});

test("impd's errors come back as isError results led by their code", async () => {
  await using ctx = await setupMcpTest();

  const missing = await ctx.runTool('imp_sleep', { name: 'ghost' });

  expect(missing.isError).toBe(true);
  expect(missing.content[0].text).toStartWith('NOT_FOUND: ');
});

test('arguments that fail the schema are an isError result that names the field', async () => {
  await using ctx = await setupMcpTest();

  const bad = await ctx.runTool('imp_create', { name: 'Not A Name', extra: 1 });

  expect(bad.isError).toBe(true);
  expect(bad.content[0].text).toContain('invalid arguments');
  expect(bad.content[0].text).toContain('name');
  expect(bad.content[0].text).toContain('extra');
});

test('imp_image_list lists the images', async () => {
  await using ctx = await setupMcpTest();

  const images = await ctx.runTool('imp_image_list');

  expect(images.structuredContent).toMatchObject({ images: [{ name: 'ubuntu' }] });
});

test('imp_fork copies a sleeping or stopped imp, now or from a checkpoint', async () => {
  await using ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'asleep', image: 'ubuntu' });
  await ctx.client.imps.create({ name: 'off', image: 'ubuntu' });
  await ctx.client.imps.sleep({ name: 'asleep' });
  await ctx.client.imps.stop({ name: 'off' });

  const checkpoint = await ctx.runTool('imp_checkpoint', { name: 'asleep', label: 'before' });

  expect(checkpoint.structuredContent).toMatchObject({ checkpoint: { label: 'before' } });

  const fromCheckpoint = await ctx.runTool('imp_fork', {
    source: 'asleep',
    name: 'fork-a',
    checkpoint: 'before',
  });

  const fromStopped = await ctx.runTool('imp_fork', { source: 'off', name: 'fork-b' });

  expect(fromCheckpoint.structuredContent).toMatchObject({ imp: { name: 'fork-a' } });
  expect(fromStopped.structuredContent).toMatchObject({ imp: { name: 'fork-b' } });
});
