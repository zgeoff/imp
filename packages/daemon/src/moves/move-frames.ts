import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { open } from 'node:fs/promises';
import * as z from 'zod';
import { findDataBlocks } from '../backup/find-data-blocks';
import type { StreamedCommand } from '../process/run-stream';

// The move stream's frames, as docs/architecture/moves.md#the-stream lays
// them out: a type byte, a 4-byte big-endian length, the payload.
export const MOVE_FRAMES = { header: 1, file: 2, data: 3, fileEnd: 4, end: 5 } as const;

type FrameType = (typeof MOVE_FRAMES)[keyof typeof MOVE_FRAMES];

// the data in one DATA frame; also the block size of the hole scan
export const MOVE_BLOCK_BYTES = 1024 * 1024;
const OFFSET_BYTES = 8;
const HEADER_BYTES = 5;
const MAX_PAYLOAD_BYTES = MOVE_BLOCK_BYTES + OFFSET_BYTES;

export const MoveFileSchema = z.object({
  kind: z.enum([
    'image-rootfs',
    'image-config',
    'checkpoint',
    'disk',
    'zfs-stream',
    'system-drive',
    'vmstate',
    'mem',
  ]),

  // a checkpoint's place, oldest first, or a ZFS stream's
  index: z.int().nonnegative().optional(),
  sizeBytes: z.int().nonnegative(),
});

export type MoveFile = z.infer<typeof MoveFileSchema>;

export const FileEndSchema = z.object({ sha256: z.string() });

function encodeFrame(type: FrameType, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(HEADER_BYTES + payload.length);
  const view = new DataView(frame.buffer);

  view.setUint8(0, type);
  view.setUint32(1, payload.length);
  frame.set(payload, HEADER_BYTES);

  return frame;
}

export function encodeJsonFrame(type: FrameType, value: unknown): Uint8Array {
  return encodeFrame(type, new TextEncoder().encode(JSON.stringify(value)));
}

function encodeDataFrame(offset: number, data: Uint8Array): Uint8Array {
  const payload = new Uint8Array(OFFSET_BYTES + data.length);

  new DataView(payload.buffer).setBigUint64(0, BigInt(offset));

  payload.set(data, OFFSET_BYTES);

  return encodeFrame(MOVE_FRAMES.data, payload);
}

// a DATA payload's offset and bytes
export function readDataPayload(payload: Uint8Array): { offset: number; data: Uint8Array } {
  if (payload.length < OFFSET_BYTES) {
    throw new Error('move stream: a DATA frame without its offset');
  }

  const view = new DataView(payload.buffer, payload.byteOffset, OFFSET_BYTES);

  return { offset: Number(view.getBigUint64(0)), data: payload.subarray(OFFSET_BYTES) };
}

// The frames of one file: FILE, its data blocks, FILE_END. `onData` counts
// the bytes as they go; the sha256 is what the receipt must repeat.
export async function* encodeFile(
  path: string,
  file: MoveFile,
  onData: (bytes: number) => void,
  sums: (sha256: string) => void,
): AsyncGenerator<Uint8Array, void, undefined> {
  const handle = await open(path, 'r');

  try {
    const stat = await handle.stat();

    const size = stat.size;

    yield encodeJsonFrame(MOVE_FRAMES.file, { ...file, sizeBytes: size });
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(MOVE_BLOCK_BYTES);

    for (const block of findDataBlocks(handle.fd, size, MOVE_BLOCK_BYTES)) {
      const offset = block * MOVE_BLOCK_BYTES;
      const length = Math.min(MOVE_BLOCK_BYTES, size - offset);

      await handle.read(buffer, 0, length, offset);

      const frame = encodeDataFrame(offset, buffer.subarray(0, length));

      hash.update(frame.subarray(HEADER_BYTES));

      onData(length);
      yield frame;
    }

    const sha256 = hash.digest('hex');

    sums(sha256);
    yield encodeJsonFrame(MOVE_FRAMES.fileEnd, { sha256 });
  } finally {
    await handle.close();
  }
}

// The frames of a command's output, such as `zfs send`: FILE, its bytes in
// DATA frames, FILE_END. A failed command fails the stream before FILE_END;
// the command starts after FILE, so a stream given up there starts none.
export async function* encodeCommand(
  openCommand: () => StreamedCommand,
  file: MoveFile,
  onData: (bytes: number) => void,
  sums: (sha256: string) => void,
): AsyncGenerator<Uint8Array, void, undefined> {
  const hash = createHash('sha256');
  const state = { offset: 0, isDone: false };

  yield encodeJsonFrame(MOVE_FRAMES.file, file);
  const command = openCommand();

  try {
    for await (const chunk of command.stdout) {
      for (let at = 0; at < chunk.length; at += MOVE_BLOCK_BYTES) {
        const piece = chunk.subarray(at, at + MOVE_BLOCK_BYTES);
        const frame = encodeDataFrame(state.offset, piece);

        hash.update(frame.subarray(HEADER_BYTES));

        state.offset += piece.length;

        onData(piece.length);
        yield frame;
      }
    }

    await command.done;

    state.isDone = true;
  } finally {
    if (!state.isDone) {
      await command.stop();
    }
  }

  const sha256 = hash.digest('hex');

  sums(sha256);
  yield encodeJsonFrame(MOVE_FRAMES.fileEnd, { sha256 });
}

// the bytes of data a file holds, holes left out: what a send carries
export async function countDataBytes(path: string): Promise<number> {
  const handle = await open(path, 'r');

  try {
    const stat = await handle.stat();

    const size = stat.size;
    let bytes = 0;

    for (const block of findDataBlocks(handle.fd, size, MOVE_BLOCK_BYTES)) {
      bytes += Math.min(MOVE_BLOCK_BYTES, size - block * MOVE_BLOCK_BYTES);
    }

    return bytes;
  } finally {
    await handle.close();
  }
}

export function createDataHash(): Hash {
  return createHash('sha256');
}

interface Frame {
  readonly type: number;
  readonly payload: Uint8Array;
}

export interface FrameReader {
  // null at a clean end
  readonly readFrame: () => Promise<Frame | null>;
  readonly cancel: () => Promise<void>;
}

// Reads frames off a byte stream, one at a time.
export function createFrameReader(stream: ReadableStream<Uint8Array>): FrameReader {
  const reader = stream.getReader();
  const state = { buffer: new Uint8Array(0), isDone: false };

  const readAtLeast = async (bytes: number): Promise<boolean> => {
    while (state.buffer.length < bytes) {
      if (state.isDone) {
        return false;
      }

      const next = await reader.read();

      if (next.done) {
        state.isDone = true;
        continue;
      }

      const joined = new Uint8Array(state.buffer.length + next.value.length);

      joined.set(state.buffer);
      joined.set(next.value, state.buffer.length);

      state.buffer = joined;
    }

    return true;
  };

  const splitOff = (bytes: number): Uint8Array => {
    const taken = state.buffer.slice(0, bytes);

    state.buffer = state.buffer.subarray(bytes);

    return taken;
  };

  return {
    readFrame: async (): Promise<Frame | null> => {
      if (!(await readAtLeast(HEADER_BYTES))) {
        if (state.buffer.length === 0) {
          return null;
        }

        throw new Error('move stream: cut off inside a frame header');
      }

      const header = splitOff(HEADER_BYTES);

      const view = new DataView(header.buffer, header.byteOffset, HEADER_BYTES);

      const type = view.getUint8(0);
      const length = view.getUint32(1);

      if (length > MAX_PAYLOAD_BYTES) {
        throw new Error(`move stream: a frame of ${String(length)} bytes`);
      }

      if (!(await readAtLeast(length))) {
        throw new Error('move stream: cut off inside a frame');
      }

      return { type, payload: splitOff(length) };
    },
    cancel: () => reader.cancel(),
  };
}

export function readJsonPayload(payload: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(payload));
}
