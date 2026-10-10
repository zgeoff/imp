import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { countGuestSleeps } from '../lib/guest-processes';
import { createInstanceClient, findImp } from '../lib/imp-cli';
import { startHttpMcpSession, startMcpSession } from '../lib/mcp';
import { readToolData } from '../lib/mcp-result';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent, removeTokenIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';

// `imp mcp` over stdio, as an agent's MCP client drives it, held to the
// suite's prefix; and impd's MCP over HTTP. The file tools' commands must
// work with BusyBox (e2e-tiny) and coreutils (impd's default image).

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  const prefix = readSuitePrefix('mcp');

  const session = await startMcpSession(['--prefix', prefix]);

  stack.defer(async () => {
    await session.close();
  });

  return { prefix, stack, client, session };
}

test('it boots an imp inside the prefix with imp_create, and refuses one outside', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}tiny`;
  const other = 'e2e-other-stdio';

  // the outside name must be free, so the cleanup below takes only what this
  // test made
  const taken = await findImp(other);

  expect(taken).toBeUndefined();

  const created = await ctx.session.runTool('imp_create', {
    name,
    image: resolveImageName('e2e-tiny'),
    memoryMib: 512,
  });

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  const outside = await ctx.session.runTool('imp_create', { name: other });

  // only a create that went through, a regressed refusal, made an imp
  registerRemoval(ctx.stack, config.keep || outside.isError, () =>
    removeImpIfPresent(ctx.client, other),
  );

  expect(readToolData(created)).toMatchObject({ imp: { name, state: 'running' } });
  expect(outside.isError).toBeTrue();
});

test.each([
  ['BusyBox', { image: resolveImageName('e2e-tiny') }],
  ['coreutils', {}],
])(
  'it round-trips a file through an odd path with %s, and a write keeps the mode of the file it replaces',
  async (tools, image) => {
    const ctx = await setupTest();

    const name = `${ctx.prefix}files-${tools.toLowerCase()}`;

    // a leading dash and spaces in each part, and shell syntax that stays text
    const path = '/root/-odd dir/-a file $(x).txt';
    const content = 'line one\nünïcode\n';

    const created = await ctx.session.runTool('imp_create', { name, memoryMib: 512, ...image });

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

    expect(readToolData(created)).toMatchObject({ imp: { name, state: 'running' } });

    const written = await ctx.session.runTool('imp_write_file', { name, path, content });
    const read = await ctx.session.runTool('imp_read_file', { name, path });

    const listed = await ctx.session.runTool('imp_exec', {
      name,
      command: `ls -la '/root/-odd dir'; stat -c %a '${path}'`,
    });

    expect(readToolData(written)).toStrictEqual({ path, bytes: Buffer.byteLength(content) });
    expect(readToolData(read)).toMatchObject({ content });

    // no temp file is left behind, and a new file gets 0666 less the umask
    expect(readToolData(listed)).toMatchObject({
      exitCode: 0,
      stdout: expect.toSatisfy(
        (stdout: string) => !stdout.includes('.imp-write.') && stdout.trimEnd().endsWith('\n644'),
      ),
      stderr: '',
    });

    await ctx.session.runTool('imp_exec', { name, command: `chmod 600 '${path}'` });
    await ctx.session.runTool('imp_write_file', { name, path, content: 'again\n' });

    const mode = await ctx.session.runTool('imp_exec', {
      name,
      command: `stat -c %a '${path}'; cat '${path}'`,
    });

    expect(readToolData(mode)).toMatchObject({ exitCode: 0, stdout: '600\nagain\n', stderr: '' });
  },
);

test.each([
  ['BusyBox', { image: resolveImageName('e2e-tiny') }],
  ['coreutils', {}],
])('it writes through a symlink and refuses a directory with %s', async (tools, image) => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}link-${tools.toLowerCase()}`;

  const created = await ctx.session.runTool('imp_create', { name, memoryMib: 512, ...image });

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  expect(readToolData(created)).toMatchObject({ imp: { name, state: 'running' } });

  // the link points at an odd path: a leading dash, a space and shell syntax
  await ctx.session.runTool('imp_exec', {
    name,
    command:
      "mkdir -p '/root/-odd dir' && echo before > '/root/-odd dir/-target $(x).txt' && ln -sf '/root/-odd dir/-target $(x).txt' /root/link.txt",
  });

  const linked = await ctx.session.runTool('imp_write_file', {
    name,
    path: '/root/link.txt',
    content: 'through\n',
  });

  const after = await ctx.session.runTool('imp_exec', {
    name,
    command: "[ -L /root/link.txt ] && echo link; cat '/root/-odd dir/-target $(x).txt'",
  });

  const directory = await ctx.session.runTool('imp_write_file', {
    name,
    path: '/root',
    content: 'x',
  });

  expect(linked.isError).toBeFalse();
  expect(readToolData(after)).toMatchObject({ exitCode: 0, stdout: 'link\nthrough\n', stderr: '' });
  expect(directory.isError).toBeTrue();
  expect(directory.content[0]?.text).toContain('/root is a directory');
});

test('it carries bytes that are not UTF-8 as base64', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}b64`;
  const bytes = Buffer.from([0, 1, 254, 255, 10]).toString('base64');

  const created = await ctx.session.runTool('imp_create', {
    name,
    image: resolveImageName('e2e-tiny'),
    memoryMib: 512,
  });

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));
  readToolData(created);

  await ctx.session.runTool('imp_write_file', {
    name,
    path: '/tmp/bin.dat',
    content: bytes,
    encoding: 'base64',
  });

  const asText = await ctx.session.runTool('imp_read_file', { name, path: '/tmp/bin.dat' });

  const asBase64 = await ctx.session.runTool('imp_read_file', {
    name,
    path: '/tmp/bin.dat',
    encoding: 'base64',
  });

  expect(asText.isError).toBeTrue();
  expect(readToolData(asBase64)).toMatchObject({ bytes: 5, content: bytes });
});

test.each([
  ['BusyBox', { image: resolveImageName('e2e-tiny') }],
  ['coreutils', {}],
])(
  'it kills the whole process group on a timeout with %s, a nohup child that ignores SIGTERM included',
  async (tools, image) => {
    const ctx = await setupTest();

    const name = `${ctx.prefix}group-${tools.toLowerCase()}`;

    const created = await ctx.session.runTool('imp_create', { name, memoryMib: 512, ...image });

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));
    readToolData(created);

    const result = await ctx.session.runTool('imp_exec', {
      name,
      command: `nohup sh -c 'trap "" TERM HUP; sleep 301' >/dev/null 2>&1 & sleep 302`,
      timeoutSeconds: 2,
    });

    const left = await countGuestSleeps(name, '30[12]');

    expect(readToolData(result)).toMatchObject({ timedOut: true });
    expect(left).toBe(0);
  },
);

test.each([
  ['BusyBox', { image: resolveImageName('e2e-tiny') }],
  ['coreutils', {}],
])(
  'it kills a child that left the process group with setsid on a timeout with %s',
  async (tools, image) => {
    const ctx = await setupTest();

    const name = `${ctx.prefix}setsid-${tools.toLowerCase()}`;

    const created = await ctx.session.runTool('imp_create', { name, memoryMib: 512, ...image });

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));
    readToolData(created);

    const result = await ctx.session.runTool('imp_exec', {
      name,
      command: `setsid sh -c 'trap "" TERM HUP; sleep 304' >/dev/null 2>&1 & sleep 305`,
      timeoutSeconds: 2,
    });

    const left = await countGuestSleeps(name, '30[45]');

    expect(readToolData(result)).toMatchObject({ timedOut: true });
    expect(left).toBe(0);
  },
);

test('it lets a job started with nohup and & outlive the call that started it', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}job`;

  const created = await ctx.session.runTool('imp_create', {
    name,
    image: resolveImageName('e2e-tiny'),
    memoryMib: 512,
  });

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));
  readToolData(created);

  const started = await ctx.session.runTool('imp_exec', {
    name,
    command: 'nohup sleep 303 >/tmp/job.log 2>&1 &',
  });

  const running = await countGuestSleeps(name, '303');

  expect(readToolData(started)).toMatchObject({ exitCode: 0, timedOut: false });
  expect(running).toBe(1);
});

test('it runs a 15 s command over HTTP for a token held to the prefix, and refuses it outside', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}http`;
  const tokenName = `${ctx.prefix}agent`;
  const other = 'e2e-other-http';

  // the outside name must be free, so the cleanup below takes only what this
  // test made
  const taken = await findImp(other);

  expect(taken).toBeUndefined();

  const created = await ctx.session.runTool('imp_create', {
    name,
    image: resolveImageName('e2e-tiny'),
    memoryMib: 512,
  });

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));
  readToolData(created);

  const token = await ctx.client.tokens.create({
    name: tokenName,
    scope: 'manage',
    imps: [`${ctx.prefix}*`],
  });

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, tokenName));

  const agent = await startHttpMcpSession(token.secret);

  ctx.stack.defer(async () => {
    await agent.close();
  });

  // longer than the API server's 10 s idle timeout; the answer comes as SSE,
  // with a keepalive comment every 5 s
  const startedAt = performance.now();

  const long = await agent.runTool('imp_exec', {
    name,
    command: 'sleep 15; echo done',
    timeoutSeconds: 60,
  });

  const seconds = (performance.now() - startedAt) / 1000;

  console.log(
    `mcp http: a 15 s exec answered after ${seconds.toFixed(1)} s, ${String(agent.readKeepalives())} keepalives`,
  );

  const outside = await agent.runTool('imp_create', { name: other });

  // only a create that went through, a regressed refusal, made an imp
  registerRemoval(ctx.stack, config.keep || outside.isError, () =>
    removeImpIfPresent(ctx.client, other),
  );

  const ended = await agent.close();

  expect(readToolData(long)).toMatchObject({ exitCode: 0, stdout: 'done\n', timedOut: false });
  expect(agent.readKeepalives()).toBeGreaterThanOrEqual(2);
  expect(outside.isError).toBeTrue();
  expect(outside.content[0]?.text).toStartWith('FORBIDDEN: ');
  expect(ended).toBe(204);
}, 60_000);

test('it shows a read token only the read tools over HTTP', async () => {
  const ctx = await setupTest();

  const tokenName = `${ctx.prefix}reader`;

  const token = await ctx.client.tokens.create({ name: tokenName, scope: 'read' });

  registerRemoval(ctx.stack, config.keep, () => removeTokenIfPresent(ctx.client, tokenName));

  const reader = await startHttpMcpSession(token.secret);

  ctx.stack.defer(async () => {
    await reader.close();
  });

  const tools = await reader.listTools();
  const refused = await reader.runTool('imp_exec', { name: `${ctx.prefix}none`, command: 'true' });

  expect(tools).toStrictEqual(['imp_list', 'imp_url', 'imp_image_list', 'imp_checkpoint_list']);
  expect(refused.content[0]?.text).toStartWith('FORBIDDEN: ');
});

test('it removes an imp with imp_destroy', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}gone`;

  const created = await ctx.session.runTool('imp_create', {
    name,
    image: resolveImageName('e2e-tiny'),
    memoryMib: 512,
  });

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));
  readToolData(created);

  const destroyed = await ctx.session.runTool('imp_destroy', { name });
  const listed = await ctx.session.runTool('imp_list', {});

  expect(readToolData(destroyed)).toStrictEqual({ destroyed: name });
  expect(readToolData(listed)).toStrictEqual({ imps: [] });
});
