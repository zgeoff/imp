import { join } from 'node:path';
import * as z from 'zod';
import { readImpEnv } from './imp-cli';
import { REPO_ROOT, instance } from './instance';
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
const ToolNameSchema = z.object({ name: z.string() });
const ToolsResponseSchema = z.object({ result: z.object({ tools: z.array(ToolNameSchema) }) });

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

export interface HttpMcpSession {
  readonly runTool: (name: string, args: Readonly<Record<string, unknown>>) => Promise<ToolResult>;
  readonly listTools: () => Promise<readonly string[]>;

  // SSE comments impd sent across this session's tool calls
  readonly readKeepalives: () => number;

  // DELETE: ends the session
  readonly close: () => Promise<number>;
}

// impd's `/mcp` endpoint with `token`, driven over HTTP as a remote agent's
// MCP client drives it: tool calls take their answer as server-sent events
export async function startHttpMcpSession(token: string): Promise<HttpMcpSession> {
  const url = `${instance.apiUrl}/mcp`;
  const state = { session: '', nextId: 1, keepalives: 0 };

  const sendPost = async (body: unknown): Promise<unknown> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(state.session !== '' && { 'mcp-session-id': state.session }),
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`POST /mcp: ${String(response.status)} ${text.trim()}`);
    }

    state.session = response.headers.get('mcp-session-id') ?? state.session;

    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      return JSON.parse(text);
    }

    state.keepalives += text.split('\n').filter((line) => line.startsWith(': keepalive')).length;

    // the response is the stream's last event; progress comes before it
    const events = text.split('\n').filter((line) => line.startsWith('data: '));
    const last = events.at(-1) ?? 'data: null';

    return JSON.parse(last.slice('data: '.length));
  };

  const sendRequest = (method: string, params: unknown): Promise<unknown> => {
    const id = state.nextId++;

    return sendPost({ jsonrpc: '2.0', id, method, params });
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
    listTools: async () => {
      const response = await sendRequest('tools/list', {});

      return ToolsResponseSchema.parse(response).result.tools.map((tool) => tool.name);
    },
    readKeepalives: () => state.keepalives,
    close: async () => {
      const response = await fetch(url, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}`, 'mcp-session-id': state.session },
      });

      return response.status;
    },
  };
}
