import { ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
import type { CallToolRequest, ServerContext } from '@modelcontextprotocol/server';
import { runAfter } from './after';
import type { After } from './after';
import type { CallRegistry } from './create-call-registry';
import { findCallerAuth } from './create-caller-auth';
import type { McpCaller } from './create-caller-auth';
import { runOnInterval } from './repeat';
import type { Repeat } from './repeat';
import type { Tool } from './tools/define-tool';
import { hasScope } from './tools/define-tool';
import { TOOLS } from './tools/tool-list';

// newest first; a 2025-era client asking for another version gets the newest.
// 2026-07-28 is served without a handshake, over HTTP and stdio alike.
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'];
const PROGRESS_INTERVAL_MS = 15_000;
const KILL_GRACE_MS = 2000;

export interface ImpServerOptions {
  // the server's version, for serverInfo
  readonly version: string;

  // shorter in tests
  readonly progressIntervalMs?: number;
  readonly killGraceMs?: number;

  // the timer behind progress notifications; setInterval when left out
  readonly repeat?: Repeat;

  // the timer behind a command's deadline and its kill grace; setTimeout
  // when left out
  readonly after?: After;

  // where a tool call that failed with a bug is reported; console.error
  // when left out, since stdout carries a stdio transport's messages
  readonly printError?: (message: string, error: unknown) => void;
}

// imp's tools as an MCP server on the SDK. `caller` opened the connection: its
// guard is in the instructions, and it calls for a request that carries no
// caller of its own (createCallerAuth). `calls` holds the calls in flight.
export function createImpServer(
  options: Readonly<ImpServerOptions>,
  caller: Readonly<McpCaller>,
  calls: Readonly<CallRegistry>,
): Server {
  const tools = new Map<string, Tool>(TOOLS.map((tool) => [tool.definition.name, tool]));

  const progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const repeat = options.repeat ?? runOnInterval;
  const after = options.after ?? runAfter;
  const printError = options.printError ?? console.error;

  const server = new Server(
    { name: 'imp', title: 'imp', version: options.version },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: [
        'imp runs persistent Linux microVMs ("imps") that sleep when idle and wake on use.',
        `This server may touch ${caller.guard.summary}.`,
        'Create an imp, run commands and read and write files in it, checkpoint before a risky change, fork to try two fixes, and destroy what you no longer need.',
      ].join(' '),
      supportedProtocolVersions: [...PROTOCOL_VERSIONS, ...MODERN_PROTOCOL_VERSIONS],
    },
  );

  // the SDK's own answer names no method
  server.fallbackRequestHandler = (request) =>
    Promise.reject(
      new ProtocolError(ProtocolErrorCode.MethodNotFound, `unknown method: ${request.method}`),
    );

  server.setRequestHandler('tools/list', (_request, ctx) => {
    const scope = (findCallerAuth(ctx.http?.authInfo)?.caller ?? caller).scope;

    return {
      tools: TOOLS.filter((tool) => hasScope(scope, tool.scope)).map((tool) => tool.definition),
    };
  });

  // never throws for a failed tool call, which is an isError result; a bug
  // is an internal error
  const runToolCall = async (request: CallToolRequest, ctx: ServerContext) => {
    const id = ctx.mcpReq.id;
    const tool = tools.get(request.params.name);

    if (tool === undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `unknown tool: ${request.params.name}`,
      );
    }

    if (calls.has(id)) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `request ${String(id)} is already running`,
      );
    }

    const requestCaller = findCallerAuth(ctx.http?.authInfo)?.caller ?? caller;

    // the SDK's signal aborts on a cancel the gate lets through, or when the
    // connection closes; the gate aborts this one alone for a call that
    // cannot be cancelled, so its answer still goes out
    const abort = new AbortController();

    const done = Promise.withResolvers<void>();

    const stopCall = (): void => {
      abort.abort(ctx.mcpReq.signal.reason);
    };

    ctx.mcpReq.signal.addEventListener('abort', stopCall, { once: true });
    calls.add(id, { abort, cancellable: tool.cancellable, done: done.promise });

    const stopProgress = startProgress(ctx, {
      intervalMs: progressIntervalMs,
      repeat,
      signal: abort.signal,
    });

    try {
      return await tool.call(request.params.arguments, {
        client: requestCaller.client,
        guard: requestCaller.guard,
        signal: abort.signal,
        killGraceMs,
        after,
      });
    } catch (error) {
      // a cancelled call's answer is dropped
      if (!abort.signal.aborted || !tool.cancellable) {
        printError('imp mcp: request failed:', error);
      }

      throw new ProtocolError(ProtocolErrorCode.InternalError, 'internal error');
    } finally {
      stopProgress();

      ctx.mcpReq.signal.removeEventListener('abort', stopCall);
      calls.remove(id);
      done.resolve();
    }
  };

  server.setRequestHandler('tools/call', async (request, ctx) => {
    try {
      return await runToolCall(request, ctx);
    } finally {
      findCallerAuth(ctx.http?.authInfo)?.onCallEnd();
    }
  });

  return server;
}

interface ProgressOptions {
  readonly intervalMs: number;
  readonly repeat: Repeat;

  // the call's cancel: a cancelled call reports no more progress
  readonly signal: Readonly<AbortSignal>;
}

// Long calls tell a client that asked for progress that they still run, so
// it can keep its own timeout from ending them; returns the stop.
function startProgress(ctx: ServerContext, options: Readonly<ProgressOptions>): () => void {
  // oxlint-disable-next-line no-underscore-dangle -- MCP names the field _meta
  const token = ctx.mcpReq._meta?.progressToken;

  if (token === undefined) {
    return () => {};
  }

  const started = Date.now();
  let progress = 0;

  const stopTimer = options.repeat(options.intervalMs, () => {
    progress += 1;

    const seconds = Math.round((Date.now() - started) / 1000);

    void ctx.mcpReq.notify({
      method: 'notifications/progress',
      params: {
        progressToken: token,
        progress,
        message: `still running after ${String(seconds)} s`,
      },
    });
  });

  const stop = (): void => {
    stopTimer();

    options.signal.removeEventListener('abort', stop);
  };

  options.signal.addEventListener('abort', stop, { once: true });

  return stop;
}
