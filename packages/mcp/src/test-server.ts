import type { Scope } from '@imp/api';
import * as z from 'zod';
import { createImpGuard } from './imp-guard';
import type { GuardOptions } from './imp-guard';
import { createMcpServer } from './mcp-server';
import type { ToolClient } from './tools/tool-client';

const ResponseSchema = z.object({
  id: z.union([z.string(), z.number()]).nullable(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

function handleUnsupported(): Promise<never> {
  return Promise.reject(new Error('the fake client does not do this'));
}

// A client with no impd behind it: `imps.list` answers with no imps after
// `listDelayMs`, `images.list` with none, and every other call fails. Tests
// that need impd itself live in packages/daemon/src/mcp.
export function buildFakeClient(listDelayMs = 0): ToolClient {
  return {
    imps: {
      list: async () => {
        await Bun.sleep(listDelayMs);

        return [];
      },
      create: handleUnsupported,
      destroy: handleUnsupported,
      sleep: handleUnsupported,
      url: handleUnsupported,
      fork: handleUnsupported,
    },
    images: { list: () => Promise.resolve([]) },
    checkpoints: {
      create: handleUnsupported,
      list: handleUnsupported,
      restore: handleUnsupported,
      delete: handleUnsupported,
    },
    openExec: handleUnsupported,
  };
}

interface ServerTestOptions {
  readonly guard?: GuardOptions;
  readonly scope?: Scope;
  readonly client?: ToolClient;
}

// a server over the fake client, as stdio runs it; `sent` holds every
// message it wrote, parsed
export function setupServerTest(options: Readonly<ServerTestOptions> = {}) {
  const sent: unknown[] = [];
  const server = createMcpServer({ version: '1.2.3' });

  const context = {
    reply: (message: string) => {
      sent.push(JSON.parse(message));
    },
    client: options.client ?? buildFakeClient(),
    guard: createImpGuard(options.guard ?? { all: true }),
    scope: options.scope ?? 'manage',
  };

  let nextId = 1;
  const handleLine = (line: string) => server.receive(line, context);

  // sends one request and returns its response, or undefined for none
  const sendRequest = async (method: string, params: unknown = {}, id: number = nextId++) => {
    await handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));

    const found = sent
      .map((message) => ResponseSchema.safeParse(message))
      .find((parsed) => parsed.success && parsed.data.id === id);

    return found?.data;
  };

  return { sent, receive: handleLine, sendRequest };
}
