import { expect, test } from 'bun:test';
import { join } from 'node:path';
import * as z from 'zod';
import { setupImpdTest } from './test-mcp';

const MessageSchema = z.record(z.string(), z.unknown());
const ToolNameSchema = z.object({ name: z.string() });
const ToolNamesSchema = z.object({ tools: z.array(ToolNameSchema) });

// the CLI's `imp mcp`, against an impd in this process
const MAIN = join(import.meta.dir, '..', '..', '..', 'cli', 'src', 'main.ts');

// as long as a subprocess test may take
const WAIT_TIMEOUT_MS = 20_000;

// `imp mcp` as a client runs it: a subprocess with JSON-RPC on its stdin and
// stdout. `messages` holds every stdout line, parsed; a line that is not JSON
// fails the parse, so nothing else may reach stdout.
function startMcp(env: Readonly<Record<string, string>>, args: readonly string[]) {
  const proc = Bun.spawn(['bun', MAIN, 'mcp', ...args], {
    env: { ...process.env, ...env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const messages: Record<string, unknown>[] = [];

  const reading = (async () => {
    const decoder = new TextDecoder();

    let buffer = '';

    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });

      const lines = buffer.split('\n');

      buffer = lines.pop() ?? '';

      for (const line of lines) {
        messages.push(MessageSchema.parse(JSON.parse(line)));
      }
    }

    expect(buffer).toBe('');
  })();

  const send = (message: unknown): void => {
    void proc.stdin.write(`${JSON.stringify(message)}\n`);
    void proc.stdin.flush();
  };

  const waitForResponse = async (id: number): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const found = messages.find((message) => message['id'] === id);

      if (found !== undefined) {
        return found;
      }

      await Bun.sleep(20);
    }

    throw new Error(`no response to ${String(id)}`);
  };

  return { proc, messages, reading, send, waitForResponse };
}

test(
  'imp mcp speaks MCP over stdio: initialize, tools/list, tools/call and errors',
  async () => {
    const impd = await setupImpdTest();

    const mcp = startMcp({ IMP_URL: impd.url, IMP_TOKEN: impd.token }, ['--prefix', 'agent-']);

    mcp.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
    });

    mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const initialized = await mcp.waitForResponse(1);

    expect(initialized['result']).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'imp' },
    });

    mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    const listed = await mcp.waitForResponse(2);

    const names = ToolNamesSchema.parse(listed['result']).tools.map((tool) => tool.name);

    expect(names).toContain('imp_exec');

    mcp.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { name: 'agent-a', image: 'ubuntu' } },
    });

    const created = await mcp.waitForResponse(3);

    expect(created['result']).toMatchObject({
      isError: false,
      structuredContent: { imp: { name: 'agent-a', state: 'running' } },
    });

    mcp.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'agent-a', command: 'echo from the guest' } },
    });

    const executed = await mcp.waitForResponse(4);

    expect(executed['result']).toMatchObject({
      structuredContent: { exitCode: 0, stdout: 'from the guest\n' },
    });

    mcp.send({ jsonrpc: '2.0', id: 5, method: 'prompts/list' });

    const unknown = await mcp.waitForResponse(5);

    expect(unknown['error']).toMatchObject({ code: -32_601 });

    // the initialized notification got no response
    expect(mcp.messages.map((message) => message['id'])).toEqual([1, 2, 3, 4, 5]);

    await mcp.proc.stdin.end();

    const code = await mcp.proc.exited;

    expect(code).toBe(0);

    await mcp.reading;
  },
  WAIT_TIMEOUT_MS,
);

test(
  'when the client goes away, a command still running in the guest is stopped',
  async () => {
    const impd = await setupImpdTest();

    await impd.client.imps.create({ name: 'box', image: 'ubuntu' });

    const mcp = startMcp({ IMP_URL: impd.url, IMP_TOKEN: impd.token }, ['--allow', 'box']);

    mcp.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
    });

    const deadline = Date.now() + WAIT_TIMEOUT_MS;

    while (impd.guest.requests.length === 0 && Date.now() < deadline) {
      await Bun.sleep(20);
    }

    await mcp.proc.stdin.end();

    const code = await mcp.proc.exited;

    expect(code).toBe(0);
    expect(impd.guest.signals).toEqual(['sleepy:15']);
    expect(mcp.messages).toEqual([]);
  },
  WAIT_TIMEOUT_MS,
);

test('imp mcp without a guard exits 2 and says how to choose one', async () => {
  const mcp = startMcp({ IMP_URL: 'http://127.0.0.1:1' }, []);

  const code = await mcp.proc.exited;

  const stderr = await new Response(mcp.proc.stderr).text();

  expect(code).toBe(2);
  expect(stderr).toBe('imp: choose the imps this server may touch: --prefix, --allow or --all\n');
});
