import type { Scope } from '@imp/api';
import { createImpGuard, createMcpServer } from '@imp/mcp';
import type { GuardOptions } from '@imp/mcp';
import { createImpClient } from '@zgeoff/imp-client';
import * as z from 'zod';
import type { AppDeps } from '../build-app';
import { TEST_TOKEN, buildTestApp, setupImpTest } from '../imps/test-imps';
import { buildStubExecGuest } from '../test-utils/build-stub-exec-guest';

// a JSON-RPC response as the tests read it
const ResponseSchema = z.object({
  id: z.union([z.string(), z.number()]).nullable(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

const TextContentSchema = z.object({ type: z.literal('text'), text: z.string() });

const ToolResultSchema = z.object({
  content: z.tuple([TextContentSchema]),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

interface ImpdTestOptions {
  readonly tailnet?: AppDeps['tailnet'];

  // the imp's agent predates the group kill (protocol 0.8.0)
  readonly oldAgent?: boolean;

  // the server's token is a manage token for these imps, not the root token
  readonly tokenImps?: readonly string[];

  // impd's environment, such as the public route's
  readonly env?: Readonly<Record<string, string>>;
}

// impd's app on a real port (exec needs a WebSocket) with the fake guest and
// an image, and a client for it
export async function setupImpdTest(options: Readonly<ImpdTestOptions> = {}) {
  const harness = await setupImpTest({ ...(options.env !== undefined && { env: options.env }) });

  const guest = buildStubExecGuest(options.oldAgent ?? false);

  // the fake guest runs no agent, but the imp wakes or boots as for a real one
  const built = buildTestApp(
    harness,
    harness,
    TEST_TOKEN,
    {
      openExec: async (name, request) => {
        await harness.imps.requireRunning(name);

        return guest.openExec(name, request);
      },
    },
    options.tailnet ?? null,
  );

  const server = built.app.listen(0);
  const url = `http://127.0.0.1:${String(server.server?.port)}`;
  const client = createImpClient({ url, token: TEST_TOKEN });

  await harness.createTestImage('ubuntu');

  return {
    ...harness,
    guest,
    client,
    rootClient: built.client,
    publicMcp: built.publicMcp,
    peers: built.peers,
    url,
    token: TEST_TOKEN,
    async [Symbol.asyncDispose]() {
      await server.stop(true);
      await harness[Symbol.asyncDispose]();
    },
  };
}

interface McpTestOptions {
  readonly guard?: GuardOptions;
  readonly scope?: Scope;

  // the imp's agent predates the group kill (protocol 0.8.0)
  readonly oldAgent?: boolean;

  // the server's token is a manage token for these imps, not the root token
  readonly tokenImps?: readonly string[];
}

// an impd as setupImpdTest makes it, and an MCP server in process over its
// client, as stdio runs it; `sent` holds every message it wrote, parsed
export async function setupMcpTest(options: Readonly<McpTestOptions> = {}) {
  const impd = await setupImpdTest({
    ...(options.oldAgent !== undefined && { oldAgent: options.oldAgent }),
  });

  const sent: unknown[] = [];
  const server = createMcpServer({ version: '1.2.3', progressIntervalMs: 50, killGraceMs: 50 });

  const scoped =
    options.tokenImps === undefined
      ? null
      : await impd.client.tokens.create({
          name: 'mcp',
          scope: 'manage',
          imps: [...options.tokenImps],
        });

  const context = {
    reply: (message: string) => {
      sent.push(JSON.parse(message));
    },
    client:
      scoped === null ? impd.client : createImpClient({ url: impd.url, token: scoped.secret }),
    guard: createImpGuard(options.guard ?? { all: true }),
    scope: options.scope ?? 'manage',
  };

  const mcp = {
    receive: (line: string) => server.receive(line, context),
    close: () => server.close(),
  };

  let nextId = 1;

  // sends one request and returns its response, or undefined when the
  // server sent none
  const sendRequest = async (method: string, params: unknown = {}, id: number = nextId++) => {
    await mcp.receive(JSON.stringify({ jsonrpc: '2.0', id, method, params }));

    const found = sent
      .map((message) => ResponseSchema.safeParse(message))
      .find((parsed) => parsed.success && parsed.data.id === id);

    return found?.data;
  };

  const runTool = async (name: string, args: unknown = {}): Promise<ToolResult> => {
    const response = await sendRequest('tools/call', { name, arguments: args });

    return ToolResultSchema.parse(response?.result);
  };

  return { ...impd, mcp, sent, sendRequest, runTool };
}
