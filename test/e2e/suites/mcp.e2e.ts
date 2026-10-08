import { afterAll, beforeAll, expect, test } from 'bun:test';
import { resolveImageName } from '../lib/fixtures';
import { runImp, tryImp } from '../lib/imp-cli';
import { startHttpMcpSession, startMcpSession } from '../lib/mcp';
import type { McpSession, ToolResult } from '../lib/mcp';
import { setupSuite } from '../lib/setup-suite';

const prefix = setupSuite('mcp');

// BusyBox in e2e-tiny, coreutils in impd's default image: the file tools'
// commands must work with both
const tiny = `${prefix}tiny`;
const full = `${prefix}full`;

// a leading dash and spaces in each part, and shell syntax that must stay text
const ODD_PATH = '/root/-odd dir/-a file $(x).txt';

// the tokens the HTTP tests make, and remove
const AGENT_TOKEN = `${prefix}agent`;
const READ_TOKEN = `${prefix}reader`;
let session: McpSession;

beforeAll(async () => {
  session = await startMcpSession(['--prefix', prefix]);
});

afterAll(async () => {
  await session.close();

  for (const name of [AGENT_TOKEN, READ_TOKEN]) {
    await tryImp(['token', 'rm', name]);
  }
});

// `imp token new`, which prints the secret alone on stdout
async function makeToken(name: string, ...args: readonly string[]): Promise<string> {
  await tryImp(['token', 'rm', name]);

  const stdout = await runImp('token', 'new', name, ...args);

  return stdout.trim();
}

function readData(result: Readonly<ToolResult>): Readonly<Record<string, unknown>> {
  const failure = result.isError ? (result.content[0]?.text ?? '') : null;

  if (failure !== null) {
    throw new Error(`the tool failed: ${failure}`);
  }

  return result.structuredContent ?? {};
}

async function runShell(name: string, command: string): Promise<Readonly<Record<string, unknown>>> {
  const result = await session.runTool('imp_exec', { name, command });

  return readData(result);
}

test('imp_create boots imps inside the prefix', async () => {
  const created = await session.runTool('imp_create', {
    name: tiny,
    image: resolveImageName('e2e-tiny'),
    memoryMib: 512,
  });

  const createdFull = await session.runTool('imp_create', { name: full, memoryMib: 512 });

  expect(readData(created)).toMatchObject({ imp: { name: tiny, state: 'running' } });
  expect(readData(createdFull)).toMatchObject({ imp: { name: full, state: 'running' } });

  const outside = await session.runTool('imp_create', { name: 'e2e-other' });

  expect(outside.isError).toBe(true);
});

test('files round-trip through odd paths, and a write keeps the mode of the file it replaces', async () => {
  for (const name of [tiny, full]) {
    const content = 'line one\nünïcode\n';

    const written = await session.runTool('imp_write_file', { name, path: ODD_PATH, content });

    expect(readData(written)).toEqual({ path: ODD_PATH, bytes: Buffer.byteLength(content) });

    const read = await session.runTool('imp_read_file', { name, path: ODD_PATH });

    expect(readData(read)).toMatchObject({ content });

    const listed = await runShell(name, `ls -la '/root/-odd dir'; stat -c %a '${ODD_PATH}'`);

    const stdout = String(listed['stdout']);

    // no temp file is left behind, and a new file gets 0666 less the umask
    expect(stdout).not.toContain('.imp-write.');
    expect(stdout.trim().split('\n').at(-1)).toBe('644');

    await runShell(name, `chmod 600 '${ODD_PATH}'`);

    await session.runTool('imp_write_file', { name, path: ODD_PATH, content: 'again\n' });

    const mode = await runShell(name, `stat -c %a '${ODD_PATH}'; cat '${ODD_PATH}'`);

    expect(mode['stdout']).toBe('600\nagain\n');
  }
});

test('a write follows a symlink and refuses a directory', async () => {
  for (const name of [tiny, full]) {
    await runShell(name, `ln -sf '${ODD_PATH}' /root/link.txt`);

    const linked = await session.runTool('imp_write_file', {
      name,
      path: '/root/link.txt',
      content: 'through\n',
    });

    expect(linked.isError).toBe(false);

    const after = await runShell(name, `[ -L /root/link.txt ] && echo link; cat '${ODD_PATH}'`);

    expect(after['stdout']).toBe('link\nthrough\n');

    const directory = await session.runTool('imp_write_file', {
      name,
      path: '/root',
      content: 'x',
    });

    expect(directory.isError).toBe(true);
    expect(directory.content[0]?.text).toContain('/root is a directory');
  }
});

test('base64 carries bytes that are not UTF-8', async () => {
  const bytes = Buffer.from([0, 1, 254, 255, 10]).toString('base64');

  await session.runTool('imp_write_file', {
    name: tiny,
    path: '/tmp/bin.dat',
    content: bytes,
    encoding: 'base64',
  });

  const asText = await session.runTool('imp_read_file', { name: tiny, path: '/tmp/bin.dat' });

  const asBase64 = await session.runTool('imp_read_file', {
    name: tiny,
    path: '/tmp/bin.dat',
    encoding: 'base64',
  });

  expect(asText.isError).toBe(true);
  expect(readData(asBase64)).toMatchObject({ bytes: 5, content: bytes });
});

// How many processes in the imp run `sleep SECONDS`, from /proc: ps lists
// every process in BusyBox but only the caller's session in procps.
async function countSleeps(name: string, seconds: string): Promise<number> {
  const result = await runShell(
    name,
    `for p in /proc/[0-9]*; do tr '\\0' ' ' < "$p/cmdline" 2>/dev/null; echo; done | grep -c '^sleep ${seconds} ' || true`,
  );

  return Number(String(result['stdout']).trim());
}

test('a timeout kills the whole process group, a nohup child that ignores SIGTERM included', async () => {
  for (const name of [tiny, full]) {
    const result = await session.runTool('imp_exec', {
      name,
      command: `nohup sh -c 'trap "" TERM HUP; sleep 301' >/dev/null 2>&1 & sleep 302`,
      timeoutSeconds: 2,
    });

    expect(readData(result)).toMatchObject({ timedOut: true });

    const left = await countSleeps(name, '30[12]');

    expect({ name, left }).toEqual({ name, left: 0 });
  }
});

test('a timeout kills a child that left the process group with setsid', async () => {
  for (const name of [tiny, full]) {
    const result = await session.runTool('imp_exec', {
      name,
      command: `setsid sh -c 'trap "" TERM HUP; sleep 304' >/dev/null 2>&1 & sleep 305`,
      timeoutSeconds: 2,
    });

    expect(readData(result)).toMatchObject({ timedOut: true });

    const left = await countSleeps(name, '30[45]');

    expect({ name, left }).toEqual({ name, left: 0 });
  }
});

test('a job started with nohup and & outlives the call that started it', async () => {
  const started = await runShell(tiny, 'nohup sleep 303 >/tmp/job.log 2>&1 &');

  expect(started).toMatchObject({ exitCode: 0, timedOut: false });

  const running = await countSleeps(tiny, '303');

  expect(running).toBe(1);
});

test('over HTTP, a token limited to the prefix runs a 15 s command and is refused outside', async () => {
  const secret = await makeToken(AGENT_TOKEN, '--scope', 'manage', '--imps', `${prefix}*`);
  const agent = await startHttpMcpSession(secret);

  // longer than the API server's 10 s idle timeout; the answer comes as SSE,
  // with a keepalive comment every 5 s
  const startedAt = performance.now();

  const long = await agent.runTool('imp_exec', {
    name: tiny,
    command: 'sleep 15; echo done',
    timeoutSeconds: 60,
  });

  const seconds = (performance.now() - startedAt) / 1000;

  console.log(
    `mcp http: a 15 s exec answered after ${seconds.toFixed(1)} s, ${String(agent.readKeepalives())} keepalives`,
  );

  expect(readData(long)).toMatchObject({ exitCode: 0, stdout: 'done\n', timedOut: false });
  expect(agent.readKeepalives()).toBeGreaterThanOrEqual(2);

  const outside = await agent.runTool('imp_create', { name: 'e2e-other' });

  expect(outside.isError).toBe(true);
  expect(outside.content[0]?.text).toStartWith('FORBIDDEN: ');

  const ended = await agent.close();

  expect(ended).toBe(204);
}, 60_000);

test('over HTTP, a read token sees only the read tools', async () => {
  const secret = await makeToken(READ_TOKEN, '--scope', 'read');
  const reader = await startHttpMcpSession(secret);
  const tools = await reader.listTools();
  const refused = await reader.runTool('imp_exec', { name: tiny, command: 'true' });

  expect(tools).toEqual(['imp_list', 'imp_url', 'imp_image_list', 'imp_checkpoint_list']);
  expect(refused.content[0]?.text).toStartWith('FORBIDDEN: ');

  await reader.close();
});

test('imp_destroy removes the imps', async () => {
  for (const name of [tiny, full]) {
    const destroyed = await session.runTool('imp_destroy', { name });

    expect(readData(destroyed)).toEqual({ destroyed: name });
  }

  const listed = await session.runTool('imp_list', {});

  expect(readData(listed)).toEqual({ imps: [] });
});
