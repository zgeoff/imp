import * as z from 'zod';
import { readImpEnv } from './imp-cli';
import { instance } from './instance';

const TIMEOUT_MS = 60_000;

const ColdBootSchema = z
  .object({ bootId: z.string(), cause: z.string(), at: z.string() })
  .readonly();

const OutputSchema = z
  .object({
    continuity: z.literal('offsets'),
    bootId: z.string(),
    executionGeneration: z.string(),
    bufferStart: z.number(),
    end: z.number(),
    offset: z.number(),
    prelude: z.number(),
    coldBoots: z.array(ColdBootSchema).readonly(),
    previous: z
      .object({ executionGeneration: z.string(), end: z.number(), exitCode: z.number().nullable() })
      .readonly()
      .optional(),
    resume: z
      .object({
        kind: z.string(),
        from: z.number().optional(),
        to: z.number().optional(),
        executionGeneration: z.string().optional(),
        firstOffset: z.number().optional(),
      })
      .readonly()
      .optional(),
  })
  .readonly();

export type SessionOutput = z.infer<typeof OutputSchema>;

const ControlSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('started'), pid: z.number(), output: OutputSchema }),
    z.object({ type: z.literal('exit'), offset: z.number().optional() }),
    z.object({ type: z.literal('detached'), reason: z.string(), offset: z.number().optional() }),
    z.object({
      type: z.literal('error'),
      code: z.string().optional(),
      message: z.string(),
      data: z.unknown().optional(),
    }),
  ])
  .readonly();

type Control = z.infer<typeof ControlSchema>;

interface ResumeFrom {
  readonly executionGeneration: string;
  readonly offset: number;
}

// what the client sends first: a session start, or an attach
export type SessionOpen =
  | {
      readonly type: 'start';
      readonly name: string;
      readonly session: string;
      readonly argv: readonly string[];
      readonly tty: true;
      readonly resumeFrom?: ResumeFrom;
    }
  | {
      readonly type: 'attach';
      readonly name: string;
      readonly session: string;
      readonly resumeFrom?: ResumeFrom;
      readonly wake?: boolean;
    };

// One `/exec` session socket (packages/api exec-protocol), raw: the first
// control message, then the session's output bytes as they arrive.
export interface SessionSocket {
  // `started`, or the `error` the open failed with
  readonly first: Control;

  // waits until `count` output bytes arrived, the prelude included
  readonly readBytes: (count: number) => Promise<Uint8Array>;
  readonly received: () => number;
  readonly close: () => void;
}

export async function openSessionSocket(open: Readonly<SessionOpen>): Promise<SessionSocket> {
  const url = `${instance.apiUrl.replace(/^http/v, 'ws')}/exec`;

  const env = await readImpEnv();

  const token = env['IMP_TOKEN'] ?? '';

  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });

  const chunks: Uint8Array[] = [];
  const controls: Control[] = [];
  const state = { bytes: 0, wake: null as (() => void) | null };

  socket.binaryType = 'arraybuffer';

  socket.addEventListener('message', (event) => {
    const data: unknown = event.data;

    if (data instanceof ArrayBuffer) {
      const chunk = new Uint8Array(data).subarray(1);

      chunks.push(chunk);

      state.bytes += chunk.byteLength;
    } else if (typeof data === 'string') {
      controls.push(ControlSchema.parse(JSON.parse(data)));
    }

    state.wake?.();
  });

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify(open));
  });

  const waitUntil = async (what: string, check: () => boolean): Promise<void> => {
    const deadline = Date.now() + TIMEOUT_MS;

    while (!check()) {
      if (Date.now() > deadline) {
        throw new Error(`${what} on ${open.session}: timed out after ${String(TIMEOUT_MS)} ms`);
      }

      await new Promise<void>((resolve) => {
        state.wake = resolve;

        setTimeout(resolve, 200);
      });
    }
  };

  await waitUntil('the first message', () => controls.length > 0);

  const [first] = controls;

  if (first === undefined) {
    throw new Error('no first message');
  }

  return {
    first,
    readBytes: async (count) => {
      await waitUntil(`${String(count)} output bytes`, () => state.bytes >= count);

      return Buffer.concat(chunks);
    },
    received: () => state.bytes,
    close: () => {
      socket.close();
    },
  };
}

// the started output a test expects; throws with the error otherwise
export function requireOutput(opened: Readonly<SessionSocket>): SessionOutput {
  if (opened.first.type !== 'started') {
    throw new Error(`expected started, got ${JSON.stringify(opened.first)}`);
  }

  return opened.first.output;
}
