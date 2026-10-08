import { expect, test } from 'bun:test';
import { setupMcpTest } from './test-mcp';

test('imp_write_file then imp_read_file round-trips text, the path passed as one argument', async () => {
  const ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const path = '/root/-odd dir/$(x) file.txt';

  const written = await ctx.runTool('imp_write_file', { name: 'dev', path, content: 'héllo\n' });

  expect(written.isError).toBe(false);
  expect(written.structuredContent).toEqual({ path, bytes: 7 });

  // the script reads the path as "$1"; it never enters the script text
  const [request] = ctx.guest.requests;

  expect(request?.argv.slice(0, 2)).toEqual(['/bin/sh', '-c']);
  expect(request?.argv.slice(3)).toEqual(['sh', path]);
  expect(request?.argv[2]).not.toContain(path);

  const read = await ctx.runTool('imp_read_file', { name: 'dev', path });

  expect(read.structuredContent).toEqual({ path, encoding: 'utf8', bytes: 7, content: 'héllo\n' });
  expect(ctx.guest.requests[1]?.argv).toEqual(['head', '-c', String(256 * 1024 + 1), path]);
});

test('base64 carries bytes that are not UTF-8, and utf8 refuses them', async () => {
  const ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const content = Buffer.from([0, 255, 254, 10]).toString('base64');

  await ctx.runTool('imp_write_file', {
    name: 'dev',
    path: '/bin.dat',
    content,
    encoding: 'base64',
  });

  expect([...(ctx.guest.files.get('/bin.dat') ?? [])]).toEqual([0, 255, 254, 10]);

  const asText = await ctx.runTool('imp_read_file', { name: 'dev', path: '/bin.dat' });

  expect(asText.isError).toBe(true);

  expect(asText.content[0].text).toStartWith(
    '/bin.dat is not valid UTF-8; read it with encoding base64',
  );

  const asBase64 = await ctx.runTool('imp_read_file', {
    name: 'dev',
    path: '/bin.dat',
    encoding: 'base64',
  });

  expect(asBase64.structuredContent).toMatchObject({ bytes: 4, content });

  const broken = await ctx.runTool('imp_write_file', {
    name: 'dev',
    path: '/x',
    content: 'not base64!',
    encoding: 'base64',
  });

  expect(broken).toMatchObject({ isError: true });
  expect(broken.content[0].text).toBe('content is not valid base64');
});

test('a file larger than maxBytes fails instead of coming back cut', async () => {
  const ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  ctx.guest.files.set('/big', new Uint8Array(100).fill(97));

  const atLimit = await ctx.runTool('imp_read_file', { name: 'dev', path: '/big', maxBytes: 100 });

  expect(atLimit.structuredContent).toMatchObject({ bytes: 100 });

  const over = await ctx.runTool('imp_read_file', { name: 'dev', path: '/big', maxBytes: 99 });

  expect(over.isError).toBe(true);
  expect(over.content[0].text).toStartWith('/big is larger than maxBytes (99)');
});

test("a read or write that fails in the guest is an isError result with the command's stderr", async () => {
  const ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const missing = await ctx.runTool('imp_read_file', { name: 'dev', path: '/nope' });

  expect(missing.isError).toBe(true);

  expect(missing.content[0].text).toStartWith(
    "could not read /nope (exit 1): head: cannot open '/nope' for reading: No such file or directory",
  );

  const denied = await ctx.runTool('imp_write_file', {
    name: 'dev',
    path: '/readonly/f',
    content: 'x',
  });

  expect(denied.isError).toBe(true);
  expect(denied.content[0].text).toContain('could not write /readonly/f (exit 1)');
  expect(denied.content[0].text).toContain('Read-only file system');
});

test('a relative path is refused before anything runs', async () => {
  const ctx = await setupMcpTest();
  const read = await ctx.runTool('imp_read_file', { name: 'dev', path: '-rf' });

  expect(read.isError).toBe(true);
  expect(read.content[0].text).toContain('must be an absolute path');
  expect(ctx.guest.requests).toEqual([]);
});

test('imp_read_file works on a sleeping and on a stopped imp', async () => {
  const ctx = await setupMcpTest();

  ctx.guest.files.set('/etc/hostname', new TextEncoder().encode('box\n'));

  await ctx.client.imps.create({ name: 'asleep', image: 'ubuntu' });
  await ctx.client.imps.create({ name: 'off', image: 'ubuntu' });
  await ctx.client.imps.sleep({ name: 'asleep' });
  await ctx.client.imps.stop({ name: 'off' });

  for (const name of ['asleep', 'off']) {
    const read = await ctx.runTool('imp_read_file', { name, path: '/etc/hostname' });

    expect(read.structuredContent).toMatchObject({ content: 'box\n' });

    const imp = await ctx.client.imps.get({ name });

    expect(imp.state).toBe('running');
  }
});
