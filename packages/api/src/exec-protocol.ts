import * as z from 'zod';
import { NameSchema } from './name-schema';
import { ResumeFromSchema, SessionOutputSchema } from './session-output-schema';
import { SessionNameSchema } from './session-schema';

// `/exec` WebSocket: text messages are JSON control (the schemas below);
// binary messages are one channel byte then raw bytes, never base64'd. The
// client sends `start` or `attach` first and waits for `started`.

// sessions outlive the socket:
// docs/architecture/daemon.md#sessions-detachable-consoles

// auth is the bearer header, or `?ticket=` from `exec.ticket` for a browser;
// a ticket starts only the imp it was issued for

export const EXEC_PATH = '/exec';
export const EXEC_TICKET_PARAM = 'ticket';

// impd closes every exec socket with this code when it stops or restarts;
// tunnel sockets too
export const EXEC_CLOSE_RESTARTING = 1012;

export const EXEC_CHANNELS = {
  stdin: 0,
  stdout: 1,
  stderr: 2,
} as const;

export type ExecChannel = (typeof EXEC_CHANNELS)[keyof typeof EXEC_CHANNELS];

export interface ExecFrame {
  readonly channel: ExecChannel;
  readonly data: Uint8Array;
}

const DimensionSchema = z.int().min(1).max(65_535);

// A tool runs from the system drive as root, with argv as its arguments:
// `tar` is `imp-agent tar`, the guest end of `imp cp`.
export const EXEC_TOOLS = ['tar'] as const;

export type ExecTool = (typeof EXEC_TOOLS)[number];

// What must hold before impd starts the command, or it refuses with
// PRECONDITION_FAILED: `broker`, the broker's variables and CA bundle
// (docs/guides/connectors.md#requiring-the-broker).
export const EXEC_REQUIREMENTS = ['broker'] as const;

export type ExecRequirement = (typeof EXEC_REQUIREMENTS)[number];

// impd acks a tool's stdin (`stdin_ack`); its client keeps at most this
// many bytes unacked, in frames of at most the next, so a large upload
// cannot grow impd's memory
export const EXEC_STDIN_WINDOW_BYTES = 1_048_576;
export const EXEC_MAX_STDIN_FRAME_BYTES = 65_536;

// the reverse: the client acks a tool's stdout (`stdout_ack`) once it is
// written, and impd sends at most this many bytes past the acks, so a slow
// disk on the client's side cannot grow the client's memory
export const EXEC_STDOUT_WINDOW_BYTES = 1_048_576;

// the agent waits for the group at most this long before its SIGKILL
const KILL_GRACE_MAX_MS = 60_000;

export const ExecStartMessageSchema = z
  .object({
    type: z.literal('start'),
    name: NameSchema,
    argv: z.array(z.string()).min(1),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    tty: z.boolean(),
    cols: DimensionSchema.optional(),
    rows: DimensionSchema.optional(),
    session: SessionNameSchema.optional(),
    tool: z.enum(EXEC_TOOLS).optional(),

    // runs as root in the agent's own world, outside the container user
    // code runs in, with the system drive's busybox: `imp exec --agent`.
    // It needs host-wide manage scope, and no exec ticket starts one.
    outer: z.boolean().optional(),

    // after the client's first SIGTERM, SIGINT, SIGHUP, SIGQUIT or SIGKILL,
    // how long the rest of the process group gets once the command exits
    // before the agent kills it; `started.groupKill` says if it will
    killGraceMs: z.int().min(1).max(KILL_GRACE_MAX_MS).optional(),

    // with a session: the output after the last byte the client saw,
    // rather than a replay; `started.output.resume` says how it was met
    resumeFrom: ResumeFromSchema.optional(),

    // an older impd drops this unread: a client checks
    // SystemInfo.features.execRequire first
    require: z.array(z.enum(EXEC_REQUIREMENTS)).optional(),
  })
  .refine((start) => start.session === undefined || start.tty, {
    message: 'a session needs a tty',
    path: ['tty'],
  })
  .refine((start) => start.resumeFrom === undefined || start.session !== undefined, {
    message: 'only a session resumes',
    path: ['resumeFrom'],
  })
  .refine((start) => start.killGraceMs === undefined || !start.tty, {
    message: 'a tty exec takes no kill grace',
    path: ['killGraceMs'],
  })
  .refine(
    (start) =>
      start.tool === undefined ||
      (!start.tty &&
        start.session === undefined &&
        start.env === undefined &&
        start.cwd === undefined),
    { message: 'a tool takes no tty, session, env or cwd', path: ['tool'] },
  )
  .refine(
    (start) => start.outer !== true || (start.tool === undefined && start.session === undefined),
    {
      message: 'an outer exec takes no tool or session',
      path: ['outer'],
    },
  )
  .refine(
    (start) =>
      start.require === undefined ||
      start.require.length === 0 ||
      (start.tool === undefined && start.outer !== true),
    { message: 'a tool or an outer exec takes no require', path: ['require'] },
  );

export const ExecAttachMessageSchema = z.object({
  type: z.literal('attach'),
  name: NameSchema,
  session: SessionNameSchema,
  cols: DimensionSchema.optional(),
  rows: DimensionSchema.optional(),
  resumeFrom: ResumeFromSchema.optional(),

  // false: fail with INVALID_STATE rather than boot or wake the imp
  wake: z.boolean().optional(),
});

export const ExecClientMessageSchema = z.discriminatedUnion('type', [
  ExecStartMessageSchema,
  ExecAttachMessageSchema,
  z.object({ type: z.literal('stdin_eof') }),
  z.object({ type: z.literal('resize'), cols: DimensionSchema, rows: DimensionSchema }),
  z.object({ type: z.literal('signal'), signal: z.string().regex(/^SIG[A-Z0-9]+$/) }),

  // a tool's stdout bytes the client wrote; impd ignores it for a plain exec
  z.object({ type: z.literal('stdout_ack'), bytes: z.int().positive() }),
]);

export type ExecClientMessage = z.infer<typeof ExecClientMessageSchema>;

// why a session socket ended without an exit: another client attached, the
// client fell too far behind, or impd lost the agent connection (the
// session runs on, and the client may attach again)
export const DETACH_REASONS = ['taken_over', 'slow', 'lost'] as const;

export type DetachReason = (typeof DETACH_REASONS)[number];

export const ExecServerMessageSchema = z.discriminatedUnion('type', [
  // session and created are set for a session; created is false when the
  // socket attached to a session that already ran
  z.object({
    type: z.literal('started'),
    pid: z.int().positive(),
    session: SessionNameSchema.optional(),
    created: z.boolean().optional(),

    // set when the start asked for a kill grace: true when the agent kills
    // what is left of the group and sends the exit only once it is gone;
    // false for an imp whose agent predates it
    groupKill: z.boolean().optional(),

    // set for a session; an impd from before offsets leaves it out
    output: SessionOutputSchema.optional(),
  }),

  // code is null when a signal ended the process; offset, for a session
  // with offsets, is the offset after the last byte this socket sent
  z.object({
    type: z.literal('exit'),
    code: z.int().nullable(),
    signal: z.string().nullable(),
    offset: z.int().nonnegative().optional(),
  }),

  // the last message of a session socket that ends without an exit
  z.object({
    type: z.literal('detached'),
    reason: z.enum(DETACH_REASONS),
    offset: z.int().nonnegative().optional(),
  }),

  // a tool's stdin bytes the agent took; sent only for a tool
  z.object({ type: z.literal('stdin_ack'), bytes: z.int().positive() }),

  // code is a contract error (NOT_FOUND, RAM_BUDGET_EXCEEDED, …) or an agent
  // error (EXEC_FAILED, …); data is that error's data, as over RPC
  z.object({
    type: z.literal('error'),
    message: z.string(),
    code: z.string().optional(),
    data: z.unknown().optional(),
  }),
]);

export type ExecServerMessage = z.infer<typeof ExecServerMessageSchema>;

// backed by an ArrayBuffer, which the DOM's WebSocket.send asks for
export function encodeExecFrame(channel: ExecChannel, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(data.byteLength + 1);

  frame[0] = channel;

  frame.set(data, 1);

  return frame;
}

export function decodeExecFrame(frame: Uint8Array): ExecFrame {
  const [channel] = frame;

  if (!isExecChannel(channel)) {
    throw new Error(`exec frame has an unknown channel byte: ${String(channel)}`);
  }

  return { channel, data: frame.subarray(1) };
}

function isExecChannel(value: number | undefined): value is ExecChannel {
  return (
    value === EXEC_CHANNELS.stdin ||
    value === EXEC_CHANNELS.stdout ||
    value === EXEC_CHANNELS.stderr
  );
}
