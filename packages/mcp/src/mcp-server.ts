import type { Scope } from '@imp/api';
import { runAfter } from './after';
import type { After } from './after';
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
import { runOnInterval } from './repeat';
import type { Repeat } from './repeat';
import type { Tool } from './tools/define-tool';
import { hasScope } from './tools/define-tool';
import type { ToolClient } from './tools/tool-client';
import { TOOLS } from './tools/tool-list';

// newest first; a client asking for another version gets the newest
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
const PROGRESS_INTERVAL_MS = 15_000;
const KILL_GRACE_MS = 2000;

export interface McpServerOptions {
  // the server's version, for serverInfo
  readonly version: string;

  // shorter in tests
  readonly progressIntervalMs?: number;
  readonly killGraceMs?: number;

  // the timer behind progress notifications (and an HTTP stream's
  // keepalive); setInterval when left out
  readonly repeat?: Repeat;

  // the timer behind a command's deadline and its kill grace; setTimeout
  // when left out
  readonly after?: After;
}

// Who one message comes from, and where its answers go. Over stdio every
// message has the same; over HTTP each POST has its own stream and its own
// caller, resolved again for each.
export interface MessageContext {
  // writes one message whole: a response, or a progress notification
  readonly reply: (message: string) => void;
  readonly client: ToolClient;
  readonly guard: ImpGuard;

  // the caller's scope: tools/list shows the tools it allows
  readonly scope: Scope;
}

export interface McpServer {
  // handles one incoming message; resolves once it is answered (a tool call
  // can take minutes, so a transport does not wait for one before the next)
  readonly receive: (line: string, context: Readonly<MessageContext>) => Promise<void>;

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
  const repeat = options.repeat ?? runOnInterval;
  const after = options.after ?? runAfter;

  // never rejects: a failed tool call is an isError result and a bug an
  // internal error
  const runToolCall = async (
    id: RequestId,
    params: Readonly<Record<string, unknown>>,
    message: Readonly<MessageContext>,
    signal: Readonly<AbortSignal>,
  ): Promise<void> => {
    const name = params['name'];
    const tool = typeof name === 'string' ? tools.get(name) : undefined;

    if (tool === undefined) {
      message.reply(formatError(id, INVALID_PARAMS, `unknown tool: ${String(name)}`));

      return;
    }

    const stopProgress = startProgress(message.reply, readProgressToken(params), {
      intervalMs: progressIntervalMs,
      repeat,
      signal,
    });

    // a cancelled call gets no response, unless the tool cannot be cancelled
    const isAnswered = (): boolean => !signal.aborted || !tool.cancellable;

    try {
      const context = {
        client: message.client,
        guard: message.guard,
        signal,
        killGraceMs,
        after,
      };

      const result = await tool.call(params['arguments'], context);

      if (isAnswered()) {
        message.reply(formatResult(id, result));
      }
    } catch (error) {
      if (isAnswered()) {
        sendInternalError(message.reply, id, error);
      }
    } finally {
      stopProgress();
    }
  };

  const handleRequest = async (
    id: RequestId,
    method: string,
    params: Readonly<Record<string, unknown>>,
    message: Readonly<MessageContext>,
  ): Promise<void> => {
    switch (method) {
      case 'initialize': {
        message.reply(formatResult(id, buildInitializeResult(params, options, message.guard)));

        return;
      }
      case 'ping': {
        message.reply(formatResult(id, {}));

        return;
      }
      case 'tools/list': {
        const allowed = TOOLS.filter((tool) => hasScope(message.scope, tool.scope));

        message.reply(formatResult(id, { tools: allowed.map((tool) => tool.definition) }));

        return;
      }
      case 'tools/call': {
        if (inFlight.has(id)) {
          message.reply(
            formatError(id, INVALID_PARAMS, `request ${String(id)} is already running`),
          );

          return;
        }

        const abort = new AbortController();

        const done = runToolCall(id, params, message, abort.signal);

        inFlight.set(id, { abort, done });

        await done;

        inFlight.delete(id);

        return;
      }
      default: {
        message.reply(formatError(id, METHOD_NOT_FOUND, `unknown method: ${method}`));
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
    receive: async (line, context) => {
      const message = parseMessage(line);

      if (message.kind === 'invalid') {
        context.reply(formatError(null, message.code, message.message));
      } else if (message.kind === 'notification') {
        handleNotification(message.method, message.params);
      } else if (message.kind === 'request') {
        try {
          await handleRequest(message.id, message.method, message.params, context);
        } catch (error) {
          sendInternalError(context.reply, message.id, error);
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
  guard: Readonly<ImpGuard>,
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
      `This server may touch ${guard.summary}.`,
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

interface ProgressOptions {
  readonly intervalMs: number;
  readonly repeat: Repeat;

  // the call's cancel: a cancelled call reports no more progress
  readonly signal: Readonly<AbortSignal>;
}

// Long calls tell a client that asked for progress that they still run, so
// it can keep its own timeout from ending them; returns the stop.
function startProgress(
  send: (message: string) => void,
  token: string | number | null,
  options: Readonly<ProgressOptions>,
): () => void {
  if (token === null) {
    return () => {};
  }

  const started = Date.now();
  let progress = 0;

  const stopTimer = options.repeat(options.intervalMs, () => {
    progress += 1;

    const seconds = Math.round((Date.now() - started) / 1000);

    send(
      formatNotification('notifications/progress', {
        progressToken: token,
        progress,
        message: `still running after ${String(seconds)} s`,
      }),
    );
  });

  const stop = (): void => {
    stopTimer();

    options.signal.removeEventListener('abort', stop);
  };

  options.signal.addEventListener('abort', stop, { once: true });

  return stop;
}

// a bug, not a failed tool call: those come back as isError results
function sendInternalError(reply: MessageContext['reply'], id: RequestId, error: unknown): void {
  console.error('imp mcp: request failed:', error);

  reply(formatError(id, INTERNAL_ERROR, 'internal error'));
}
