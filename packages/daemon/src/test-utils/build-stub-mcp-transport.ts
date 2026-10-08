import type { HttpTransport } from '@imp/mcp';

// one request the transport took, and the end of its tool call
interface StubMcpCall {
  readonly request: Request;

  // ends the call's tool: readCallEnd's promise resolves
  readonly end: () => void;
}

// MCP's HTTP transport with every answer a tool call's open event stream,
// whose tool runs until the test ends it: `calls` holds each request with
// its `end`, and `closes` counts the transport's close.
export function buildStubMcpTransport() {
  const calls: StubMcpCall[] = [];

  const callEnds = new WeakMap<Response, Promise<void>>();

  const state = { closes: 0 };

  const transport: HttpTransport = {
    handle: (request) => {
      const ended = Promise.withResolvers<void>();

      const response = new Response(new ReadableStream<Uint8Array>({ start: () => {} }), {
        headers: { 'content-type': 'text/event-stream' },
      });

      callEnds.set(response, ended.promise);
      calls.push({ request, end: ended.resolve });

      return Promise.resolve(response);
    },
    close: () => {
      state.closes += 1;

      return Promise.resolve();
    },
    readCallEnd: (response) => callEnds.get(response) ?? null,
  };

  return {
    ...transport,
    calls,
    get closes(): number {
      return state.closes;
    },
  };
}
