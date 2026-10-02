import type { ImpClient } from '@zgeoff/imp-client';
import type { ImpGuard } from './imp-guard';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  formatError,
  formatNotification,
  formatResult,
  parseMessage,
} from './json-rpc';
import type { RequestId } from './json-rpc';
import type { Tool } from './tools/define-tool';
import { TOOLS } from './tools/tool-list';

// newest first; a client asking for another version gets the newest
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
const PROGRESS_INTERVAL_MS = 15_000;
const KILL_GRACE_MS = 2000;

export interface McpServerOptions {
  readonly client: ImpClient;
  readonly guard: ImpGuard;

  // the server's version, for serverInfo
  readonly version: string;

  // writes one message; a transport sends it whole, as one line or one body
  readonly send: (message: string) => void;

  // shorter in tests
  readonly progressIntervalMs?: number;
  readonly killGraceMs?: number;
}

export interface McpServer {
  // handles one incoming message; resolves once it is answered (a tool call
  // can take minutes, so a transport does not wait for one before the next)
  readonly receive: (line: string) => Promise<void>;

  // for a client that went away: cancels every call in flight and waits for
  // them to stop (a command in a guest gets SIGTERM, then SIGKILL)
  readonly close: () => Promise<void>;
}

interface InFlight {
  readonly abort: AbortController;

  // never rejects
  readonly done: Promise<void>;
}

// MCP over any transport that carries JSON-RPC messages: the tools, their
// cancels and their progress. Tools are the only capability.
export function createMcpServer(options: Readonly<McpServerOptions>): McpServer {
  const tools = new Map<string, Tool>(TOOLS.map((tool) => [tool.definition.name, tool]));
  const inFlight = new Map<RequestId, InFlight>();

  const progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;

  // never rejects: a failed tool call is an isError result, a bug an
  // internal error, and a cancelled call gets no response at all
  const runToolCall = async (
    id: RequestId,
    params: Readonly<Record<string, unknown>>,
    signal: Readonly<AbortSignal>,
  ): Promise<void> => {
    const name = params['name'];
    const tool = typeof name === 'string' ? tools.get(name) : undefined;

    if (tool === undefined) {
      options.send(formatError(id, INVALID_PARAMS, `unknown tool: ${String(name)}`));

      return;
    }

    const stopProgress = startProgress(options.send, readProgressToken(params), progressIntervalMs);

    try {
      const context = { client: options.client, guard: options.guard, signal, killGraceMs };

      const result = await tool.call(params['arguments'], context);

      if (!signal.aborted) {
        options.send(formatResult(id, result));
      }
    } catch (error) {
      if (!signal.aborted) {
        sendInternalError(id, error);
      }
    } finally {
      stopProgress();
    }
  };

  const sendInternalError = (id: RequestId, error: unknown): void => {
    // a bug, not a failed tool call: those come back as isError results
    console.error('imp mcp: request failed:', error);
    options.send(formatError(id, INTERNAL_ERROR, 'internal error'));
  };

  const handleRequest = async (
    id: RequestId,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    switch (method) {
      case 'initialize': {
        options.send(formatResult(id, buildInitializeResult(params, options)));

        return;
      }
      case 'ping': {
        options.send(formatResult(id, {}));

        return;
      }
      case 'tools/list': {
        options.send(formatResult(id, { tools: TOOLS.map((tool) => tool.definition) }));

        return;
      }
      case 'tools/call': {
        if (inFlight.has(id)) {
          options.send(formatError(id, INVALID_PARAMS, `request ${String(id)} is already running`));

          return;
        }

        const abort = new AbortController();

        const done = runToolCall(id, params, abort.signal);

        inFlight.set(id, { abort, done });

        await done;

        inFlight.delete(id);

        return;
      }
      default: {
        options.send(formatError(id, METHOD_NOT_FOUND, `unknown method: ${method}`));
      }
    }
  };

  const handleNotification = (method: string, params: Readonly<Record<string, unknown>>): void => {
    if (method !== 'notifications/cancelled') {
      return;
    }

    const requestId = params['requestId'];

    if (typeof requestId === 'string' || typeof requestId === 'number') {
      inFlight.get(requestId)?.abort.abort(new Error('the client cancelled the call'));
    }
  };

  return {
    receive: async (line) => {
      const message = parseMessage(line);

      if (message.kind === 'invalid') {
        options.send(formatError(null, message.code, message.message));
      } else if (message.kind === 'notification') {
        handleNotification(message.method, message.params);
      } else if (message.kind === 'request') {
        try {
          await handleRequest(message.id, message.method, message.params);
        } catch (error) {
          sendInternalError(message.id, error);
        }
      }

      // a response needs nothing: this server sends no requests
    },
    close: async () => {
      const calls = [...inFlight.values()];

      for (const call of calls) {
        call.abort.abort(new Error('the client went away'));
      }

      await Promise.all(calls.map((call) => call.done));
    },
  };
}

function buildInitializeResult(
  params: Readonly<Record<string, unknown>>,
  options: Readonly<McpServerOptions>,
) {
  const requested = params['protocolVersion'];
  const supported: readonly string[] = PROTOCOL_VERSIONS;

  return {
    protocolVersion:
      typeof requested === 'string' && supported.includes(requested)
        ? requested
        : PROTOCOL_VERSIONS[0],
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'imp', title: 'imp', version: options.version },
    instructions: [
      'imp runs persistent Linux microVMs ("imps") that sleep when idle and wake on use.',
      `This server may touch ${options.guard.summary}.`,
      'Create an imp, run commands and read and write files in it, checkpoint before a risky change, fork to try two fixes, and destroy what you no longer need.',
    ].join(' '),
  };
}

function readProgressToken(params: Readonly<Record<string, unknown>>): string | number | null {
  const meta = params['_meta'];

  if (typeof meta !== 'object' || meta === null || !('progressToken' in meta)) {
    return null;
  }

  const token: unknown = meta.progressToken;

  return typeof token === 'string' || typeof token === 'number' ? token : null;
}

// Long calls tell a client that asked for progress that they still run, so
// it can keep its own timeout from ending them; returns the stop.
function startProgress(
  send: (message: string) => void,
  token: string | number | null,
  intervalMs: number,
): () => void {
  if (token === null) {
    return () => {};
  }

  const started = Date.now();
  let progress = 0;

  const timer = setInterval(() => {
    progress += 1;

    const seconds = Math.round((Date.now() - started) / 1000);

    send(
      formatNotification('notifications/progress', {
        progressToken: token,
        progress,
        message: `still running after ${String(seconds)} s`,
      }),
    );
  }, intervalMs);

  return () => {
    clearInterval(timer);
  };
}
