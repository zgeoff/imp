import { expect, test } from 'bun:test';
import { setupMcpTest } from './test-mcp';

test('imp_exec runs a command line through /bin/sh -c and returns its output', async () => {
  await using ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const result = await ctx.runTool('imp_exec', {
    name: 'dev',
    command: 'echo hi',
    cwd: '/srv',
    env: { A: '1' },
  });

  expect(result.isError).toBe(false);

  expect(result.structuredContent).toEqual({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: 'hi\n',
    stderr: '',
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
  });

  expect(ctx.guest.requests[0]).toMatchObject({
    argv: ['/bin/sh', '-c', 'echo hi'],
    cwd: '/srv',
    env: ['A=1'],
  });
});

test('imp_exec runs argv as it is, with stdin, and a non-zero exit is not a tool error', async () => {
  await using ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const echoed = await ctx.runTool('imp_exec', { name: 'dev', argv: ['cat'], stdin: 'piped' });

  expect(echoed.structuredContent).toMatchObject({ exitCode: 0, stdout: 'piped' });

  const failed = await ctx.runTool('imp_exec', { name: 'dev', argv: ['fail'] });

  expect(failed.isError).toBe(false);

  expect(failed.structuredContent).toMatchObject({
    exitCode: 3,
    stdout: 'partial',
    stderr: 'boom',
  });
});

test('imp_exec needs exactly one of command and argv', async () => {
  await using ctx = await setupMcpTest();

  const neither = await ctx.runTool('imp_exec', { name: 'dev' });
  const both = await ctx.runTool('imp_exec', { name: 'dev', command: 'x', argv: ['x'] });

  expect(neither.isError).toBe(true);
  expect(both.isError).toBe(true);
  expect(both.content[0].text).toContain('give either command or argv');
});

test('imp_exec has no exec in the agent: an outer field is refused, and nothing runs', async () => {
  await using ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const result = await ctx.runTool('imp_exec', { name: 'dev', argv: ['ls'], outer: true });

  expect(result.isError).toBe(true);
  expect(ctx.guest.requests).toEqual([]);
});

test('imp_exec keeps the head and the tail of a large output and counts what it dropped', async () => {
  await using ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const result = await ctx.runTool('imp_exec', {
    name: 'dev',
    command: 'flood 1000000',
    maxOutputBytes: 16_384,
  });

  const stdout = String(result.structuredContent?.['stdout']);

  expect(result.structuredContent).toMatchObject({
    exitCode: 0,
    stdoutDroppedBytes: 1_000_000 - 16_384,
  });

  expect(stdout).toStartWith('HEAD');
  expect(stdout).toEndWith('TAIL');
  expect(stdout).toContain(`\n[... ${String(1_000_000 - 16_384)} bytes dropped ...]\n`);
});

test('a timeout sends SIGTERM to the command and reports timedOut', async () => {
  await using ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const result = await ctx.runTool('imp_exec', {
    name: 'dev',
    command: 'sleepy',
    timeoutSeconds: 1,
  });

  expect(result.structuredContent).toMatchObject({
    timedOut: true,
    exitCode: null,
    signal: 'SIGTERM',
  });

  expect(ctx.guest.signals).toEqual(['sleepy:15']);

  // the agent kills what is left of the group itself: no second exec
  expect(ctx.guest.requests).toHaveLength(1);
  expect(ctx.guest.requests[0]).toMatchObject({ killGraceMs: 50 });
});

// before protocol 0.8.0 the rest of the group outlives the stop until the
// imp restarts (docs/guides/operations.md#upgrade)
test('on an agent from before the group kill, a stop opens no second exec', async () => {
  await using ctx = await setupMcpTest({ oldAgent: true });

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const result = await ctx.runTool('imp_exec', {
    name: 'dev',
    command: 'sleepy',
    timeoutSeconds: 1,
  });

  expect(result.structuredContent).toMatchObject({ timedOut: true, signal: 'SIGTERM' });
  expect(ctx.guest.requests).toHaveLength(1);
});

test('a command that ignores SIGTERM gets SIGKILL after the grace', async () => {
  await using ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const result = await ctx.runTool('imp_exec', {
    name: 'dev',
    command: 'stubborn',
    timeoutSeconds: 1,
  });

  expect(result.structuredContent).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
  expect(ctx.guest.signals).toEqual(['stubborn:15', 'stubborn:9']);

  // the session carried SIGKILL to the whole group: no sweep
  expect(ctx.guest.requests).toHaveLength(1);
});

test('a cancelled exec stops the command and gets no response', async () => {
  await using ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const call = ctx.sendRequest(
    'tools/call',
    { name: 'imp_exec', arguments: { name: 'dev', command: 'stubborn' } },
    7,
  );

  await waitUntil(() => ctx.guest.requests.length === 1);

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 7, reason: 'user' },
    }),
  );

  const response = await call;

  expect(response).toBeUndefined();
  expect(ctx.guest.signals).toEqual(['stubborn:15', 'stubborn:9']);
});

test('close stops every call in flight, as when the client goes away', async () => {
  await using ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const call = ctx.sendRequest('tools/call', {
    name: 'imp_exec',
    arguments: { name: 'dev', command: 'sleepy' },
  });

  await waitUntil(() => ctx.guest.requests.length === 1);

  await ctx.mcp.close();

  const response = await call;

  expect(response).toBeUndefined();
  expect(ctx.guest.signals).toEqual(['sleepy:15']);
});

test('a call with a progress token gets progress notifications while it runs', async () => {
  await using ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });

  const result = await ctx.sendRequest('tools/call', {
    name: 'imp_exec',
    arguments: { name: 'dev', command: 'sleepy', timeoutSeconds: 1 },
    _meta: { progressToken: 'p1' },
  });

  expect(result?.result).toMatchObject({ structuredContent: { timedOut: true } });

  const progress = ctx.sent.filter(
    (message) => typeof message === 'object' && message !== null && 'method' in message,
  );

  expect(progress.length).toBeGreaterThanOrEqual(5);

  expect(progress[0]).toMatchObject({
    method: 'notifications/progress',
    params: { progressToken: 'p1', progress: 1 },
  });

  expect(progress[1]).toMatchObject({ params: { progress: 2 } });
});

test('an exec on a stopped imp boots it first', async () => {
  await using ctx = await setupMcpTest();

  await ctx.client.imps.create({ name: 'dev', image: 'ubuntu' });
  await ctx.client.imps.stop({ name: 'dev' });

  const result = await ctx.runTool('imp_exec', { name: 'dev', command: 'echo up' });

  expect(result.structuredContent).toMatchObject({ exitCode: 0, stdout: 'up\n' });

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.state).toBe('running');
});

async function waitUntil(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    if (check()) {
      return;
    }

    await Bun.sleep(10);
  }

  throw new Error('timed out waiting');
}
