import { isMessage } from '@bufbuild/protobuf';
import type {
  ExecRequirement,
  PreviousGeneration,
  ResumeFrom,
  ResumeResult,
  SessionOutput,
} from '@impz/api';
import { AgentError, openAgentConnection } from './agent-connection';
import type { AgentConnection } from './agent-connection';
import { buildAgentOutdatedError, handleUnknownOp } from './agent-outdated';
import {
  DetachedSchema,
  ErrorDataSchema,
  ExitSchema,
  ResizeSchema,
  SignalSchema,
  StartedSchema,
} from './agent-protocol';
import type { Previous, Resume, Started } from './agent-protocol';
import { readFrameWithin, requireNoAgentError, sendRequestFrame } from './agent-requests';
import type { AgentRequest } from './agent-requests';
import { decodeAgentMessage } from './decode-agent-message';
import { encodeAgentMessage } from './encode-agent-message';
import { FRAME_TYPES, decodeJsonPayload } from './frame-codec';
import { hasAgentNameForms } from './has-agent-name-forms';

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

  // a session impd keeps a log of; an agent from before session logs
  // ignores it, and its STARTED says no log
  readonly log?: boolean;

  // runs in the agent's own world, outside the inner container, as root:
  // the exec.outer op, which an older agent refuses
  readonly outer?: boolean;

  // what impd checks before it starts the command (exec/exec-require.ts);
  // never sent to the agent
  readonly require?: readonly ExecRequirement[];
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

// Opens an exec connection and waits for STARTED. Throws AgentError
// (EXEC_FAILED) when the process cannot start.
export async function openExecStream(
  vsockPath: string,
  request: Readonly<AgentExecRequest>,
  startTimeoutMs = EXEC_START_TIMEOUT_MS,
): Promise<ExecStream> {
  const { argv, env, resumeFrom, outer, require: _checked, ...rest } = request;
  const op = outer === true ? 'exec.outer' : 'exec';

  const opening = openStream(
    vsockPath,
    {
      op,
      ...rest,
      argv: [...argv],
      ...(env !== undefined && { env: [...env] }),
      ...(resumeFrom !== undefined && { resumeFrom }),
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

// Taps a logged session's raw output beside its viewer, from resumeFrom or
// the ring's start; it counts as no connection. Throws NO_SESSION, and
// BAD_REQUEST for a session without a log.
export function openTapStream(
  vsockPath: string,
  session: string,
  resumeFrom?: ResumeFrom,
  startTimeoutMs = EXEC_START_TIMEOUT_MS,
): Promise<ExecStream> {
  return openStream(
    vsockPath,
    {
      op: 'session.tap',
      session,
      ...(resumeFrom !== undefined && { resumeFrom }),
    },
    startTimeoutMs,
  ).catch(handleUnknownOp('session-log'));
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
      ...(resumeFrom !== undefined && { resumeFrom }),
    },
    startTimeoutMs,
  ).catch(handleUnknownOp('sessions'));
}

async function openStream(
  vsockPath: string,
  request: AgentRequest,
  startTimeoutMs: number,
): Promise<ExecStream> {
  const connection = await openAgentConnection(vsockPath);

  let started: Started;
  let output: SessionOutput | null;

  try {
    sendRequestFrame(connection, request);

    const first = await readFrameWithin(connection, startTimeoutMs);

    if (first === null) {
      throw new Error('agent closed the exec connection before the process started');
    }

    requireNoAgentError(first);

    if (first.type !== FRAME_TYPES.started) {
      throw new Error(`agent exec: expected STARTED, got frame type ${String(first.type)}`);
    }

    started = decodeAgentMessage(StartedSchema, decodeJsonPayload(first));

    if (!hasAgentNameForms(started)) {
      throw new Error(
        'agent exec: STARTED names a session, generation or boot the agent never makes',
      );
    }

    output = toSessionOutput(started);
  } catch (error) {
    connection.close();
    throw toApiAgentError(error);
  }

  return {
    pid: started.pid,
    session: started.session ?? null,
    created: started.created ?? false,
    groupKill: (started.killGraceMs ?? 0) > 0,
    output,
    writeStdin: (data) => {
      connection.send(FRAME_TYPES.stdin, data);
    },
    stdinDrained: connection.drained,
    closeStdin: () => {
      connection.send(FRAME_TYPES.stdinEof);
    },
    resize: (cols, rows) => {
      connection.sendJson(FRAME_TYPES.resize, encodeAgentMessage(ResizeSchema, { cols, rows }));
    },
    sendSignal: (signal) => {
      connection.sendJson(FRAME_TYPES.signal, encodeAgentMessage(SignalSchema, { signal }));
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
      const exit = decodeAgentMessage(ExitSchema, decodeJsonPayload(frame));

      yield { type: 'exit', code: exit.code, signal: exit.signal };

      return;
    } else if (frame.type === FRAME_TYPES.detached) {
      const detached = decodeAgentMessage(DetachedSchema, decodeJsonPayload(frame));

      yield { type: 'detached', reason: detached.reason };

      return;
    }
  }
}

// a session from an agent without offsets replays as before
function toSessionOutput(started: Started): SessionOutput | null {
  if (started.session === undefined) {
    return null;
  }

  const output = started.output;

  if (output === undefined) {
    return { continuity: 'none' };
  }

  return {
    continuity: 'offsets',
    bootId: output.bootId,
    executionGeneration: output.executionGeneration,
    bufferStart: output.bufferStart,
    end: output.end,
    offset: output.offset,
    prelude: output.prelude,
    coldBoots: [],
    ...(output.previous !== undefined && { previous: toPrevious(output.previous) }),
    ...(output.resume !== undefined && { resume: toResume(output.resume) }),
    ...(output.log === true && { log: { enabled: true } }),
  };
}

// a kind this impd does not know, or one without its fields, throws: the
// data that follows has no place it can name
function toResume(resume: Resume): ResumeResult {
  if (resume.kind === 'exact') {
    return { kind: 'exact' };
  }

  if (resume.kind === 'gap' && resume.from !== undefined && resume.to !== undefined) {
    return { kind: 'gap', from: resume.from, to: resume.to };
  }

  if (
    resume.kind === 'generation_changed' &&
    resume.executionGeneration !== undefined &&
    resume.firstOffset !== undefined
  ) {
    return {
      kind: 'generation_changed',
      executionGeneration: resume.executionGeneration,
      firstOffset: resume.firstOffset,
    };
  }

  throw new Error(`agent exec: a resume of kind ${JSON.stringify(resume.kind)} without its fields`);
}

// exitCode is null when a signal ended the process, as an API exit's code
function toPrevious(previous: Previous): PreviousGeneration {
  const exit = previous.exit ?? { code: 0, signal: 0 };

  return {
    executionGeneration: previous.executionGeneration,
    end: previous.end,
    exitCode: exit.signal === 0 ? exit.code : null,
  };
}

// The agent's error data in the API's shape: NO_SESSION's (coldBoots is
// impd's to add) and INVALID_RESUME's. Data an older agent lacks, that lacks
// its code's fields, or whose names lack their agent's form, goes.
function toApiAgentError(error: unknown): unknown {
  if (!(error instanceof AgentError) || error.data === undefined) {
    return error;
  }

  return new AgentError(error.code, error.detail, toApiErrorData(error.code, error.data));
}

function toApiErrorData(code: string, data: unknown): unknown {
  if (!isMessage(data, ErrorDataSchema) || !hasAgentNameForms(data)) {
    return undefined;
  }

  if (code === 'NO_SESSION' && data.bootId !== undefined) {
    return {
      bootId: data.bootId,
      coldBoots: [],
      ...(data.previous !== undefined && { previous: toPrevious(data.previous) }),
    };
  }

  if (code === 'INVALID_RESUME' && data.end !== undefined && data.bufferStart !== undefined) {
    return { end: data.end, bufferStart: data.bufferStart };
  }

  return undefined;
}
