import * as z from 'zod';
import { NameSchema } from './name-schema';
import { SessionNameSchema } from './session-schema';

// `/exec` WebSocket: text messages are JSON control (the schemas below);
// binary messages are one channel byte then raw bytes, never base64'd. The
// client sends `start` or `attach` first and waits for `started`.

// sessions outlive the socket: docs/architecture/daemon.md#sessions

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

// impd acks a tool's stdin (`stdin_ack`); its client keeps at most this
// many bytes unacked, in frames of at most the next, so a large upload
// cannot grow impd's memory
export const EXEC_STDIN_WINDOW_BYTES = 1_048_576;
export const EXEC_MAX_STDIN_FRAME_BYTES = 65_536;

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
  })
  .refine((start) => start.session === undefined || start.tty, {
    message: 'a session needs a tty',
    path: ['tty'],
  })
  .refine(
    (start) =>
      start.tool === undefined ||
      (!start.tty &&
        start.session === undefined &&
        start.env === undefined &&
        start.cwd === undefined),
    { message: 'a tool takes no tty, session, env or cwd', path: ['tool'] },
  );

export const ExecAttachMessageSchema = z.object({
  type: z.literal('attach'),
  name: NameSchema,
  session: SessionNameSchema,
  cols: DimensionSchema.optional(),
  rows: DimensionSchema.optional(),
});

export const ExecClientMessageSchema = z.discriminatedUnion('type', [
  ExecStartMessageSchema,
  ExecAttachMessageSchema,
  z.object({ type: z.literal('stdin_eof') }),
  z.object({ type: z.literal('resize'), cols: DimensionSchema, rows: DimensionSchema }),
  z.object({ type: z.literal('signal'), signal: z.string().regex(/^SIG[A-Z0-9]+$/) }),
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
  }),

  // code is null when a signal ended the process
  z.object({
    type: z.literal('exit'),
    code: z.int().nullable(),
    signal: z.string().nullable(),
  }),

  // the last message of a session socket that ends without an exit
  z.object({ type: z.literal('detached'), reason: z.enum(DETACH_REASONS) }),

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
