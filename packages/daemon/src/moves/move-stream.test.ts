import { expect, test } from 'bun:test';
import { closeSync, ftruncateSync, mkdtempSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { readRejection } from '../read-rejection';
import {
  MOVE_BLOCK_BYTES,
  MOVE_FRAMES,
  countDataBytes,
  createFrameReader,
  encodeFile,
  readDataPayload,
} from './move-frames';
import { createPartPipe, sendInParts } from './move-parts';

function createSparseFile(): string {
  const dir = mkdtempSync(join(process.env['TMPDIR'] ?? '/tmp', 'move-stream-'));
  const path = join(dir, 'disk');
  const fd = openSync(path, 'w');

  ftruncateSync(fd, 8 * MOVE_BLOCK_BYTES);
  writeSync(fd, 'first', 0, 'utf8');
  writeSync(fd, 'sixth', 5 * MOVE_BLOCK_BYTES, 'utf8');
  closeSync(fd);

  return path;
}

async function collectFile(path: string) {
  const frames: Uint8Array[] = [];
  const sums: string[] = [];

  const encoded = encodeFile(
    path,
    { kind: 'disk', sizeBytes: 0 },
    () => {},
    (sum) => {
      sums.push(sum);
    },
  );

  for await (const frame of encoded) {
    frames.push(frame);
  }

  return { frames, sums };
}

// the chunks as a generator, for sendInParts
async function* encodeChunks(
  chunks: readonly Uint8Array[],
): AsyncGenerator<Uint8Array, void, undefined> {
  for (const chunk of chunks) {
    await Promise.resolve();

    yield chunk;
  }
}

function toStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  const queue = [...chunks];

  return new ReadableStream({
    pull: (controller) => {
      const next = queue.shift();

      if (next === undefined) {
        controller.close();

        return;
      }

      controller.enqueue(next);
    },
  });
}

test('a sparse file goes as its data blocks only, and reads back at their offsets', async () => {
  const path = createSparseFile();

  const collected = await collectFile(path);

  const reader = createFrameReader(toStream(collected.frames));
  const types: number[] = [];
  const offsets: number[] = [];

  for (let frame = await reader.readFrame(); frame !== null; frame = await reader.readFrame()) {
    types.push(frame.type);

    if (frame.type === MOVE_FRAMES.data) {
      offsets.push(readDataPayload(frame.payload).offset);
    }
  }

  expect(types).toEqual([
    MOVE_FRAMES.file,
    MOVE_FRAMES.data,
    MOVE_FRAMES.data,
    MOVE_FRAMES.fileEnd,
  ]);

  expect(offsets).toEqual([0, 5 * MOVE_BLOCK_BYTES]);

  const dataBytes = await countDataBytes(path);

  expect(collected.sums).toHaveLength(1);
  expect(dataBytes).toBe(2 * MOVE_BLOCK_BYTES);
});

test('a stream cut off inside a frame is an error, not a clean end', async () => {
  const collected = await collectFile(createSparseFile());

  const bytes = collected.frames[1] ?? new Uint8Array(0);
  const reader = createFrameReader(toStream([bytes.subarray(0, 100)]));

  const error = await readRejection(reader.readFrame());

  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain('cut off inside a frame');
});

test('parts split the frames at the limit, and the pipe joins them back in order', async () => {
  const chunks = Array.from({ length: 7 }, (_unused, index) => new Uint8Array(10).fill(index));
  const pipe = createPartPipe(1000);
  const sizes: number[] = [];

  const joined = new Response(pipe.stream).bytes();

  const count = await sendInParts(
    encodeChunks(chunks),
    async (_part, body) => {
      const bytes = await new Response(body).bytes();

      sizes.push(bytes.length);

      await pipe.push(toStream([bytes]));
    },
    25,
  );

  pipe.end();

  const all = await joined;

  expect(count).toBe(3);
  expect(sizes).toEqual([25, 25, 20]);
  expect(Buffer.from(all)).toEqual(Buffer.concat(chunks));
});

test('a failed post closes the frames, so their files close', async () => {
  const closed = { isClosed: false };
  const frames = encodeChunks([new Uint8Array(30), new Uint8Array(30)]);
  const close = frames.return.bind(frames);

  frames.return = (value) => {
    closed.isClosed = true;

    return close(value);
  };

  const error = await readRejection(
    sendInParts(frames, () => Promise.reject(new Error('the peer went away')), 10),
  );

  expect(String(error)).toContain('the peer went away');
  expect(closed.isClosed).toBe(true);
});

test('the pipe gives up when the next part does not come', async () => {
  const pipe = createPartPipe(20);

  const error = await readRejection(new Response(pipe.stream).bytes());

  expect(String(error)).toContain('did not come');
});
