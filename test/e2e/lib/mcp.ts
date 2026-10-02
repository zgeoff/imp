import { join } from 'node:path';
import * as z from 'zod';
import { readImpEnv } from './imp-cli';
import { REPO_ROOT } from './instance';
import { waitFor } from './wait-for';

const IMP_SCRIPT = join(REPO_ROOT, 'scripts', 'imp');
const MessageSchema = z.looseObject({ id: z.unknown().optional() });
const ContentSchema = z.object({ type: z.string(), text: z.string() });

const ToolResultSchema = z.object({
  content: z.array(ContentSchema),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean(),
});

const ToolResponseSchema = z.object({ result: ToolResultSchema });

export interface ToolResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly structuredContent?: Readonly<Record<string, unknown>> | undefined;
  readonly isError: boolean;
}

export interface McpSession {
  readonly runTool: (name: string, args: Readonly<Record<string, unknown>>) => Promise<ToolResult>;

  // closes stdin, as a client that goes away does, and waits for the exit
  readonly close: () => Promise<number>;
}

// `imp mcp ARGS...` against the dev instance, driven over stdio as an agent's
// MCP client drives it
export async function startMcpSession(args: readonly string[]): Promise<McpSession> {
  const env = await readImpEnv();

  const proc = Bun.spawn([IMP_SCRIPT, 'mcp', ...args], {
    env: { ...process.env, ...env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const responses = new Map<unknown, unknown>();

  void (async () => {
    const decoder = new TextDecoder();

    let buffer = '';

    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });

      const lines = buffer.split('\n');

      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const message = MessageSchema.parse(JSON.parse(line));

        responses.set(message.id, message);
      }
    }
  })();

  let nextId = 1;

  const sendRequest = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;

    void proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    void proc.stdin.flush();

    return waitFor(
      `the response to ${method}`,
      () => {
        const response = responses.get(id);

        if (response === undefined) {
          throw new Error('no response yet');
        }

        return Promise.resolve(response);
      },
      { timeoutMs: 300_000, intervalMs: 50 },
    );
  };

  await sendRequest('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e' },
  });

  return {
    runTool: async (name, toolArgs) => {
      const response = await sendRequest('tools/call', { name, arguments: toolArgs });

      return ToolResponseSchema.parse(response).result;
    },
    close: async () => {
      await proc.stdin.end();

      return proc.exited;
    },
  };
}
