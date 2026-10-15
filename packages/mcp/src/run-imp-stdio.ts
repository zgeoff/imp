import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { createCallRegistry } from './create-call-registry';
import type { McpCaller } from './create-caller-auth';
import { createImpServer } from './create-imp-server';
import type { ImpServerOptions } from './create-imp-server';

// MCP over this process's stdin and stdout, as `impz mcp` serves it. Resolves
// once the client has closed stdin and the calls it left, which the SDK
// aborts, have stopped.
export async function runImpStdio(
  options: Readonly<ImpServerOptions>,
  caller: Readonly<McpCaller>,
): Promise<void> {
  const calls = createCallRegistry();
  const closed = Promise.withResolvers<void>();

  serveStdio(() => createImpServer(options, caller, calls), {
    transport: calls.createGate(new StdioServerTransport(), closed.resolve),
  });

  await closed.promise;

  await calls.drain();
}
