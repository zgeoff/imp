import type { McpServer } from './mcp-server';

// MCP's stdio transport, inbound: one JSON-RPC message per line, each handled
// as it arrives, so a long tool call never holds up a ping or a cancel. The
// end of the input means the client is gone, and the calls it left stop.
export async function handleLines(
  input: ReadableStream<Uint8Array>,
  server: Readonly<McpServer>,
): Promise<void> {
  const decoder = new TextDecoder();

  let buffer = '';

  const handleLine = (line: string): void => {
    if (line.trim() !== '') {
      void server.receive(line);
    }
  };

  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });

    const lines = buffer.split('\n');

    buffer = lines.pop() ?? '';

    for (const line of lines) {
      handleLine(line);
    }
  }

  handleLine(buffer + decoder.decode());

  await server.close();
}
