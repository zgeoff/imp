import * as z from 'zod';
import { openAgentConnection } from './agent-connection';
import type { AgentConnection } from './agent-connection';
import { buildAgentOutdatedError, handleUnknownOp } from './agent-outdated';
import { AgentExitSchema, readFrameWithin, requireNoAgentError } from './agent-requests';
import { FRAME_TYPES, decodeJsonPayload } from './frame-codec';

export interface AgentExecRequest {
  readonly argv: readonly string[];
  readonly env?: readonly string[];
  readonly cwd?: string;
  readonly tty: boolean;
  readonly cols?: number;
  readonly rows?: number;
  readonly user?: string;

  // starts this session, or attaches to it if it runs; needs a tty
  readonly session?: string;

  // after a stop signal, how long the rest of the process group gets before
  // the agent kills it; see docs/architecture/protocol.md#exec
  readonly killGraceMs?: number;
}

// attaches to a session that exists
export interface AgentAttachRequest {
  readonly session: string;
  readonly cols?: number;
  readonly rows?: number;
}

export type ExecEvent =
  | { readonly type: 'stdout' | 'stderr'; readonly data: Uint8Array }
  | { readonly type: 'exit'; readonly code: number; readonly signal: number }

  // the agent ended a session connection: `taken_over` or `slow`
  | { readonly type: 'detached'; readonly reason: string };

export interface ExecStream {
  readonly pid: number;

  // set for a session; created is false when the stream attached to a
  // session that already ran
  readonly session: string | null;
  readonly created: boolean;

  // the agent kills what is left of the group once the command stops after
  // a stop signal, and sends the exit only then; false for an agent from
  // before 0.8.0, which ignores killGraceMs
  readonly groupKill: boolean;
  readonly writeStdin: (data: Uint8Array) => void;

  // resolves once the stdin written so far is on its way to the guest; a
  // writer that waits for it holds no more than a socket buffer of it
  readonly stdinDrained: () => Promise<void>;
  readonly closeStdin: () => void;
  readonly resize: (cols: number, rows: number) => void;

  // a Linux signal number, sent to the whole process group
  readonly sendSignal: (signal: number) => void;

  // stdout and stderr in order, then one exit or detached; ends early
  // when the connection drops
  readonly events: () => AsyncGenerator<ExecEvent, void, undefined>;

  // the agent sends SIGHUP to a plain exec whose connection closes; a
  // session just detaches
  readonly close: () => void;
}

// a hung agent must not leave the exec, and the activity count it holds,
// pending for good
const EXEC_START_TIMEOUT_MS = 10_000;

const StartedSchema = z.object({
  pid: z.int(),
  session: z.string().optional(),
  created: z.boolean().optional(),
  kill_grace_ms: z.int().optional(),
});

const DetachedSchema = z.object({ reason: z.string() });

// Opens an exec connection and waits for STARTED. Throws AgentError
// (EXEC_FAILED) when the process cannot start.
export async function openExecStream(
  vsockPath: string,
  request: Readonly<AgentExecRequest>,
  startTimeoutMs = EXEC_START_TIMEOUT_MS,
): Promise<ExecStream> {
  const { killGraceMs, ...rest } = request;

  const stream = await openStream(
    vsockPath,
    { op: 'exec', ...rest, ...(killGraceMs !== undefined && { kill_grace_ms: killGraceMs }) },
    startTimeoutMs,
  );

  // an agent from before sessions ignores the name and runs a plain exec,
  // which would die with its connection; a woken imp keeps its old agent
  if (request.session !== undefined && stream.session === null) {
    stream.close();
    throw buildAgentOutdatedError('sessions');
  }

  return stream;
}

// Attaches to a session and waits for STARTED; the replay follows as
// stdout. Throws AgentError (NO_SESSION) when there is no such session, and
// AGENT_OUTDATED for an agent from before sessions.
export function openAttachStream(
  vsockPath: string,
  request: Readonly<AgentAttachRequest>,
  startTimeoutMs = EXEC_START_TIMEOUT_MS,
): Promise<ExecStream> {
  return openStream(vsockPath, { op: 'session.attach', ...request }, startTimeoutMs).catch(
    handleUnknownOp('sessions'),
  );
}

async function openStream(
  vsockPath: string,
  request: Readonly<Record<string, unknown>>,
  startTimeoutMs: number,
): Promise<ExecStream> {
  const connection = await openAgentConnection(vsockPath);

  let started: z.infer<typeof StartedSchema>;

  try {
    connection.sendJson(FRAME_TYPES.request, request);

    const first = await readFrameWithin(connection, startTimeoutMs);

    if (first === null) {
      throw new Error('agent closed the exec connection before the process started');
    }

    requireNoAgentError(first);

    if (first.type !== FRAME_TYPES.started) {
      throw new Error(`agent exec: expected STARTED, got frame type ${String(first.type)}`);
    }

    started = StartedSchema.parse(decodeJsonPayload(first));
  } catch (error) {
    connection.close();
    throw error;
  }

  return {
    pid: started.pid,
    session: started.session ?? null,
    created: started.created ?? false,
    groupKill: (started.kill_grace_ms ?? 0) > 0,
    writeStdin: (data) => {
      connection.send(FRAME_TYPES.stdin, data);
    },
    stdinDrained: connection.drained,
    closeStdin: () => {
      connection.send(FRAME_TYPES.stdinEof);
    },
    resize: (cols, rows) => {
      connection.sendJson(FRAME_TYPES.resize, { cols, rows });
    },
    sendSignal: (signal) => {
      connection.sendJson(FRAME_TYPES.signal, { signal });
    },
    events: () => readExecEvents(connection),
    close: connection.close,
  };
}

async function* readExecEvents(
  connection: AgentConnection,
): AsyncGenerator<ExecEvent, void, undefined> {
  for (;;) {
    const frame = await connection.next();

    if (frame === null) {
      return;
    }

    if (frame.type === FRAME_TYPES.stdout || frame.type === FRAME_TYPES.stderr) {
      const type = frame.type === FRAME_TYPES.stdout ? 'stdout' : 'stderr';

      yield { type, data: frame.payload };
    } else if (frame.type === FRAME_TYPES.exit) {
      const exit = AgentExitSchema.parse(decodeJsonPayload(frame));

      yield { type: 'exit', code: exit.code, signal: exit.signal };

      return;
    } else if (frame.type === FRAME_TYPES.detached) {
      const detached = DetachedSchema.parse(decodeJsonPayload(frame));

      yield { type: 'detached', reason: detached.reason };

      return;
    }
  }
}
