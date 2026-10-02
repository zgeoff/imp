import type { PreviousGeneration, ResumeFrom, ResumeResult, SessionOutput } from '@imp/api';
import * as z from 'zod';
import { AgentError, openAgentConnection } from './agent-connection';
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

  // with a session: the output after this byte, not a replay
  readonly resumeFrom?: ResumeFrom;

  // runs in the agent's own world, outside the inner container, as root:
  // the exec.outer op, which an older agent refuses
  readonly outer?: boolean;
}

// attaches to a session that exists
export interface AgentAttachRequest {
  readonly session: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly resumeFrom?: ResumeFrom;

  // impd's alone, never sent to the agent: false fails with INVALID_STATE
  // rather than boot or wake the imp
  readonly wake?: boolean;
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

  // a session's place in its output, null for a plain exec; coldBoots is
  // empty until impd adds the imp's (docs/architecture/daemon.md#output-offsets)
  readonly output: SessionOutput | null;
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
const OffsetSchema = z.int().nonnegative();

const AgentPreviousSchema = z.object({
  execution_generation: z.string(),
  end: OffsetSchema,
  exit: AgentExitSchema,
});

const AgentResumeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact') }),
  z.object({ kind: z.literal('gap'), from: OffsetSchema, to: OffsetSchema }),
  z.object({
    kind: z.literal('generation_changed'),
    execution_generation: z.string(),
    first_offset: OffsetSchema,
  }),
]);

const AgentOutputSchema = z.object({
  boot_id: z.string(),
  execution_generation: z.string(),
  buffer_start: OffsetSchema,
  end: OffsetSchema,
  offset: OffsetSchema,
  prelude: OffsetSchema,
  previous: AgentPreviousSchema.optional(),
  resume: AgentResumeSchema.optional(),
});

const StartedSchema = z.object({
  pid: z.int(),
  session: z.string().optional(),
  created: z.boolean().optional(),
  kill_grace_ms: z.int().optional(),

  // an agent from before output offsets leaves it out
  output: AgentOutputSchema.optional(),
});

const NoSessionDataSchema = z.object({
  boot_id: z.string(),
  previous: AgentPreviousSchema.optional(),
});

const InvalidResumeDataSchema = z.object({ end: OffsetSchema, buffer_start: OffsetSchema });
const DetachedSchema = z.object({ reason: z.string() });

// Opens an exec connection and waits for STARTED. Throws AgentError
// (EXEC_FAILED) when the process cannot start.
export async function openExecStream(
  vsockPath: string,
  request: Readonly<AgentExecRequest>,
  startTimeoutMs = EXEC_START_TIMEOUT_MS,
): Promise<ExecStream> {
  const { killGraceMs, resumeFrom, outer, ...rest } = request;
  const op = outer === true ? 'exec.outer' : 'exec';

  const opening = openStream(
    vsockPath,
    {
      op,
      ...rest,
      ...(killGraceMs !== undefined && { kill_grace_ms: killGraceMs }),
      ...(resumeFrom !== undefined && { resume_from: toAgentResumeFrom(resumeFrom) }),
    },
    startTimeoutMs,
  );

  const stream = await (outer === true ? opening.catch(handleUnknownOp('outer-exec')) : opening);

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
  const { resumeFrom, wake: _wake, ...rest } = request;

  return openStream(
    vsockPath,
    {
      op: 'session.attach',
      ...rest,
      ...(resumeFrom !== undefined && { resume_from: toAgentResumeFrom(resumeFrom) }),
    },
    startTimeoutMs,
  ).catch(handleUnknownOp('sessions'));
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
    throw toApiAgentError(error);
  }

  return {
    pid: started.pid,
    session: started.session ?? null,
    created: started.created ?? false,
    groupKill: (started.kill_grace_ms ?? 0) > 0,
    output: toSessionOutput(started),
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

function toAgentResumeFrom(resumeFrom: Readonly<ResumeFrom>) {
  return { execution_generation: resumeFrom.executionGeneration, offset: resumeFrom.offset };
}

// a session from an agent without offsets replays as before
function toSessionOutput(started: z.infer<typeof StartedSchema>): SessionOutput | null {
  if (started.session === undefined) {
    return null;
  }

  const output = started.output;

  if (output === undefined) {
    return { continuity: 'none' };
  }

  return {
    continuity: 'offsets',
    bootId: output.boot_id,
    executionGeneration: output.execution_generation,
    bufferStart: output.buffer_start,
    end: output.end,
    offset: output.offset,
    prelude: output.prelude,
    coldBoots: [],
    ...(output.previous !== undefined && { previous: toPrevious(output.previous) }),
    ...(output.resume !== undefined && { resume: toResume(output.resume) }),
  };
}

function toResume(resume: z.infer<typeof AgentResumeSchema>): ResumeResult {
  if (resume.kind === 'generation_changed') {
    return {
      kind: 'generation_changed',
      executionGeneration: resume.execution_generation,
      firstOffset: resume.first_offset,
    };
  }

  return resume;
}

// exitCode is null when a signal ended the process, as an API exit's code
function toPrevious(previous: z.infer<typeof AgentPreviousSchema>): PreviousGeneration {
  return {
    executionGeneration: previous.execution_generation,
    end: previous.end,
    exitCode: previous.exit.signal === 0 ? previous.exit.code : null,
  };
}

// The agent's error data in the API's shape: NO_SESSION's (coldBoots is
// impd's to add) and INVALID_RESUME's. Data an older agent lacks, or that
// does not parse, goes.
function toApiAgentError(error: unknown): unknown {
  if (!(error instanceof AgentError) || error.data === undefined) {
    return error;
  }

  return new AgentError(error.code, error.detail, toApiErrorData(error.code, error.data));
}

function toApiErrorData(code: string, data: unknown): unknown {
  if (code === 'NO_SESSION') {
    const parsed = NoSessionDataSchema.safeParse(data);

    if (!parsed.success) {
      return undefined;
    }

    const previous = parsed.data.previous;

    return {
      bootId: parsed.data.boot_id,
      coldBoots: [],
      ...(previous !== undefined && { previous: toPrevious(previous) }),
    };
  }

  if (code === 'INVALID_RESUME') {
    const parsed = InvalidResumeDataSchema.safeParse(data);

    return parsed.success
      ? { end: parsed.data.end, bufferStart: parsed.data.buffer_start }
      : undefined;
  }

  return undefined;
}
