import { INVALID_PARAMS, isJSONRPCRequest } from '@modelcontextprotocol/server';
import type { JSONRPCErrorResponse, RequestId, Transport } from '@modelcontextprotocol/server';

interface Call {
  readonly abort: AbortController;
  readonly cancellable: boolean;

  // never rejects
  readonly done: Promise<void>;
}

// The tool calls in flight on one MCP connection (a stdio pipe, or one HTTP
// session), by their JSON-RPC id.
export interface CallRegistry {
  // true from a tool call's arrival at the gate until it ends or is answered
  readonly isRunning: (id: RequestId) => boolean;

  // `done` settles once the call has ended
  readonly add: (id: RequestId, call: Readonly<Call>) => void;
  readonly remove: (id: RequestId) => void;

  // waits for every call in flight to end
  readonly drain: () => Promise<void>;

  // The SDK drops a cancelled request's answer, so the gate keeps the cancel
  // of a call that cannot be cancelled from it: only the call's own signal
  // aborts, and its answer still goes out. `onClose` runs once it closes.
  readonly createGate: (transport: Transport, onClose?: () => void) => Transport;
}

export function createCallRegistry(): CallRegistry {
  const calls = new Map<RequestId, Call>();

  // tool calls past the gate that have not started yet
  const arriving = new Set<RequestId>();

  const isRunning = (id: RequestId): boolean => arriving.has(id) || calls.has(id);

  // true when the message is a cancel the gate keeps from the SDK
  const holdCancel = (message: unknown): boolean => {
    const requestId = readCancelledRequestID(message);
    const call = requestId === null ? undefined : calls.get(requestId);

    if (call === undefined || call.cancellable) {
      return false;
    }

    call.abort.abort(new Error('the client cancelled the call'));

    return true;
  };

  return {
    isRunning,
    add: (id, call) => {
      arriving.delete(id);
      calls.set(id, call);
    },
    remove: (id) => {
      calls.delete(id);
    },
    drain: async () => {
      await Promise.all([...calls.values()].map((call) => call.done));
    },
    createGate: (inner, onClose) => {
      const gate: Transport = {
        start: () => inner.start(),
        send: (message, options) => {
          // a call the SDK refuses before it starts ends with its answer
          if (!('method' in message) && message.id !== undefined) {
            arriving.delete(message.id);
          }

          return inner.send(message, options);
        },
        close: () => inner.close(),
        get sessionId() {
          return inner.sessionId;
        },
        setProtocolVersion: (version) => inner.setProtocolVersion?.(version),
        setSupportedProtocolVersions: (versions) => inner.setSupportedProtocolVersions?.(versions),
      };

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- an SDK Transport has only on* hooks
      inner.onmessage = (message, extra) => {
        if (holdCancel(message)) {
          return;
        }

        // the SDK keeps one abort per id, which a second call would replace
        if (isJSONRPCRequest(message) && message.method === 'tools/call') {
          if (isRunning(message.id)) {
            void inner.send(buildDuplicateError(message.id));

            return;
          }

          arriving.add(message.id);
        }

        gate.onmessage?.(message, extra);
      };

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- an SDK Transport has only on* hooks
      inner.onclose = () => {
        gate.onclose?.();
        onClose?.();
      };

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- an SDK Transport has only on* hooks
      inner.onerror = (error) => gate.onerror?.(error);

      return gate;
    },
  };
}

// the request a `notifications/cancelled` names; null for any other message
function readCancelledRequestID(message: unknown): RequestId | null {
  if (typeof message !== 'object' || message === null || !('method' in message)) {
    return null;
  }

  if (message.method !== 'notifications/cancelled' || !('params' in message)) {
    return null;
  }

  const params: unknown = message.params;

  if (typeof params !== 'object' || params === null || !('requestId' in params)) {
    return null;
  }

  const requestId: unknown = params.requestId;

  return typeof requestId === 'string' || typeof requestId === 'number' ? requestId : null;
}

// the answer to a tool call whose id a running call holds
function buildDuplicateError(id: RequestId): JSONRPCErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: INVALID_PARAMS, message: `request ${String(id)} is already running` },
  };
}
