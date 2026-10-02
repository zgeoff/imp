import * as z from 'zod';
import { NameSchema } from './name-schema';

// `/exec` WebSocket: text messages are JSON control (the schemas below);
// binary messages are one channel byte then raw bytes, so stream data is
// never base64'd. The client sends `start` first and waits for `started`.

// auth is the bearer header, or `?ticket=` from `exec.ticket` for a browser;
// a ticket starts only the imp it was issued for

export const EXEC_PATH = '/exec';
export const EXEC_TICKET_PARAM = 'ticket';

// impd closes every exec socket with this code when it stops or restarts
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

export const ExecStartMessageSchema = z.object({
  type: z.literal('start'),
  name: NameSchema,
  argv: z.array(z.string()).min(1),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  tty: z.boolean(),
  cols: DimensionSchema.optional(),
  rows: DimensionSchema.optional(),
});

export const ExecClientMessageSchema = z.discriminatedUnion('type', [
  ExecStartMessageSchema,
  z.object({ type: z.literal('stdin_eof') }),
  z.object({ type: z.literal('resize'), cols: DimensionSchema, rows: DimensionSchema }),
  z.object({ type: z.literal('signal'), signal: z.string().regex(/^SIG[A-Z0-9]+$/) }),
]);

export type ExecClientMessage = z.infer<typeof ExecClientMessageSchema>;

export const ExecServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('started'), pid: z.int().positive() }),

  // code is null when a signal ended the process
  z.object({
    type: z.literal('exit'),
    code: z.int().nullable(),
    signal: z.string().nullable(),
  }),

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

export function encodeExecFrame(channel: ExecChannel, data: Uint8Array): Uint8Array {
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
