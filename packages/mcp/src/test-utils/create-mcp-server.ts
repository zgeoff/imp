import { deserializeMessage, isJSONRPCRequest } from '@modelcontextprotocol/server';
import type { RequestId, Server, Transport } from '@modelcontextprotocol/server';
import { createCallRegistry } from '../create-call-registry';
import { createCallerAuth } from '../create-caller-auth';
import type { McpCaller } from '../create-caller-auth';
import { createImpServer } from '../create-imp-server';
import type { ImpServerOptions } from '../create-imp-server';

// Who one message comes from, and where its answers go
export interface MessageContext extends McpCaller {
  // gets each message the server sends about the request, whole: its
  // progress, then its response
  readonly reply: (message: string) => void;
}

export interface TestMcpServer {
  // delivers one JSON-RPC message; resolves once a request is answered, or
  // once a cancelled call that gets no answer has ended
  readonly receive: (line: string, context: Readonly<MessageContext>) => Promise<void>;

  // as when the client goes away: cancels every call in flight and waits
  // for them to stop
  readonly close: () => Promise<void>;
}

// imp's real MCP server, behind the call registry's gate, over an in-memory
// transport. The first message's context opens the connection; each message
// carries its own caller, as each HTTP request does.
export function createMcpServer(options: Readonly<ImpServerOptions>): TestMcpServer {
  const calls = createCallRegistry();
  const state: { server: Server | null } = { server: null };

  const replies = new Map<RequestId, MessageContext['reply']>();

  // the receives still waiting for an answer, newest last: a refusal of a
  // duplicate id answers the newest, the running call the one before
  const waiting = new Map<RequestId, (() => void)[]>();

  const transport: Transport = {
    start: () => Promise.resolve(),
    send: (message, sendOptions) => {
      const isResponse = !('method' in message);
      const id = isResponse ? message.id : sendOptions?.relatedRequestId;

      if (id !== undefined && id !== null) {
        replies.get(id)?.(JSON.stringify(message));
      }

      if (isResponse && id !== undefined && id !== null) {
        waiting.get(id)?.pop()?.();
      }

      return Promise.resolve();
    },
    close: () => {
      transport.onclose?.();

      return Promise.resolve();
    },
  };

  const gate = calls.createGate(transport);

  const openServer = async (caller: Readonly<McpCaller>): Promise<void> => {
    if (state.server === null) {
      state.server = createImpServer(options, caller, calls);

      await state.server.connect(gate);
    }
  };

  return {
    receive: async (line, context) => {
      const message = deserializeMessage(line);

      await openServer(context);

      if (!isJSONRPCRequest(message)) {
        transport.onmessage?.(message, { authInfo: createCallerAuth(context) });

        // the SDK runs a notification's handler on a later microtask
        await waitForMicrotasks();

        return;
      }

      const answered = Promise.withResolvers<void>();

      replies.set(message.id, context.reply);
      waiting.set(message.id, [...(waiting.get(message.id) ?? []), answered.resolve]);

      // a cancelled call gets no answer: its end resolves the receive, once
      // the SDK has had its chance to answer
      const authInfo = createCallerAuth(context, () => {
        void (async () => {
          await waitForMicrotasks();

          answered.resolve();
        })();
      });

      transport.onmessage?.(message, { authInfo });

      await answered.promise;
    },
    close: async () => {
      await state.server?.close();
      await calls.drain();
    },
  };
}

// every microtask queued so far, and the ones they queue, have run
function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
