import * as z from 'zod';
import { openAgentConnection } from './agent-connection';
import type { AgentConnection } from './agent-connection';
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
  readonly writeStdin: (data: Uint8Array) => void;
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
});

const DetachedSchema = z.object({ reason: z.string() });

// Opens an exec connection and waits for STARTED. Throws AgentError
// (EXEC_FAILED) when the process cannot start.
export function openExecStream(
  vsockPath: string,
  request: Readonly<AgentExecRequest>,
  startTimeoutMs = EXEC_START_TIMEOUT_MS,
): Promise<ExecStream> {
  return openStream(vsockPath, { op: 'exec', ...request }, startTimeoutMs);
}

// Attaches to a session and waits for STARTED; the replay follows as
// stdout. Throws AgentError (NO_SESSION) when there is no such session.
export function openAttachStream(
  vsockPath: string,
  request: Readonly<AgentAttachRequest>,
  startTimeoutMs = EXEC_START_TIMEOUT_MS,
): Promise<ExecStream> {
  return openStream(vsockPath, { op: 'session.attach', ...request }, startTimeoutMs);
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
    writeStdin: (data) => {
      connection.send(FRAME_TYPES.stdin, data);
    },
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
