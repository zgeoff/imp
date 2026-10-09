import { expect, mock, onTestFinished, test } from 'bun:test';
import { closeSync, ftruncateSync, openSync, writeSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { createStreamRunner } from '../process/run-stream';
import {
  MOVE_BLOCK_BYTES,
  MOVE_FRAMES,
  countDataBytes,
  createFrameReader,
  encodeCommand,
  encodeFile,
  readDataPayload,
  readJsonPayload,
} from './move-frames';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'move-frames-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('#encodeFile sends a sparse file as its FILE frame, its data blocks and its FILE_END', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'disk');
  const fd = openSync(path, 'w');

  ftruncateSync(fd, 8 * MOVE_BLOCK_BYTES);
  writeSync(fd, 'first', 0, 'utf8');
  writeSync(fd, 'sixth', 5 * MOVE_BLOCK_BYTES, 'utf8');
  closeSync(fd);

  const frames = await Array.fromAsync(
    encodeFile(
      path,
      { kind: 'disk', sizeBytes: 0 },
      () => {},
      () => {},
    ),
  );

  const reader = createFrameReader(new Blob(frames).stream());

  const read = [
    await reader.readFrame(),
    await reader.readFrame(),
    await reader.readFrame(),
    await reader.readFrame(),
    await reader.readFrame(),
  ];

  expect(read.map((frame) => frame?.type)).toStrictEqual([
    MOVE_FRAMES.file,
    MOVE_FRAMES.data,
    MOVE_FRAMES.data,
    MOVE_FRAMES.fileEnd,
    undefined,
  ]);
});

test('#encodeFile places each data block of a sparse file at its offset', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'disk');
  const fd = openSync(path, 'w');

  ftruncateSync(fd, 8 * MOVE_BLOCK_BYTES);
  writeSync(fd, 'first', 0, 'utf8');
  writeSync(fd, 'sixth', 5 * MOVE_BLOCK_BYTES, 'utf8');
  closeSync(fd);

  const frames = await Array.fromAsync(
    encodeFile(
      path,
      { kind: 'disk', sizeBytes: 0 },
      () => {},
      () => {},
    ),
  );

  const reader = createFrameReader(new Blob(frames).stream());

  await reader.readFrame();

  const first = await reader.readFrame();
  const second = await reader.readFrame();

  invariant(first);
  invariant(second);

  expect(readDataPayload(first.payload).offset).toBe(0);
  expect(readDataPayload(second.payload).offset).toBe(5 * MOVE_BLOCK_BYTES);
});

test('#encodeFile hands over the sha256 that its FILE_END frame carries', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'disk');
  const sums: string[] = [];

  await Bun.write(path, 'data');

  const frames = await Array.fromAsync(
    encodeFile(
      path,
      { kind: 'disk', sizeBytes: 0 },
      () => {},
      (sum) => {
        sums.push(sum);
      },
    ),
  );

  const reader = createFrameReader(new Blob(frames.slice(-1)).stream());

  const fileEnd = await reader.readFrame();

  invariant(fileEnd);

  expect(sums).toStrictEqual([expect.toSatisfy((sum: string) => /^[\da-f]{64}$/v.test(sum))]);
  expect(readJsonPayload(fileEnd.payload)).toStrictEqual({ sha256: sums[0] });
});

test('#countDataBytes counts only the data blocks of a sparse file', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dir, 'disk');
  const fd = openSync(path, 'w');

  ftruncateSync(fd, 8 * MOVE_BLOCK_BYTES);
  writeSync(fd, 'first', 0, 'utf8');
  writeSync(fd, 'sixth', 5 * MOVE_BLOCK_BYTES, 'utf8');
  closeSync(fd);

  const bytes = await countDataBytes(path);

  expect(bytes).toBe(2 * MOVE_BLOCK_BYTES);
});

test('#createFrameReader rejects a stream cut off inside a frame', () => {
  const header = new Uint8Array(5);

  new DataView(header.buffer).setUint8(0, MOVE_FRAMES.data);
  new DataView(header.buffer).setUint32(1, 100);

  const reader = createFrameReader(new Blob([header, new Uint8Array(40)]).stream());

  expect(reader.readFrame()).rejects.toThrowWithMessage(
    Error,
    'move stream: cut off inside a frame',
  );
});

test('#createFrameReader rejects a stream cut off inside a frame header', () => {
  const reader = createFrameReader(new Blob([new Uint8Array(3)]).stream());

  expect(reader.readFrame()).rejects.toThrowWithMessage(
    Error,
    'move stream: cut off inside a frame header',
  );
});

test('#createFrameReader rejects a frame longer than a data block and its offset', () => {
  const header = new Uint8Array(5);

  new DataView(header.buffer).setUint8(0, MOVE_FRAMES.data);
  new DataView(header.buffer).setUint32(1, 1024 * 1024 + 9);

  const reader = createFrameReader(new Blob([header]).stream());

  expect(reader.readFrame()).rejects.toThrowWithMessage(
    Error,
    'move stream: a frame of 1048585 bytes',
  );
});

test('#readDataPayload rejects a DATA payload shorter than its offset', () => {
  expect(() => readDataPayload(new Uint8Array(7))).toThrowWithMessage(
    Error,
    'move stream: a DATA frame without its offset',
  );
});

test('#encodeCommand starts no command when the stream is given up at its FILE frame', async () => {
  const runner = createStreamRunner();
  const openCommand = mock(() => runner.readFrom(['yes']));

  const frames = encodeCommand(
    openCommand,
    { kind: 'zfs-stream', index: 0, sizeBytes: 0 },
    () => {},
    () => {},
  );

  await frames.next();
  await frames.return();

  expect(openCommand).not.toHaveBeenCalled();
});

test('#encodeCommand stops the command when the stream is given up after its output began', async () => {
  const runner = createStreamRunner();
  const command = runner.readFrom(['yes']);

  onTestFinished(() => command.stop());

  const frames = encodeCommand(
    () => command,
    { kind: 'zfs-stream', index: 0, sizeBytes: 0 },
    () => {},
    () => {},
  );

  await frames.next();
  await frames.next();
  await frames.return();

  // `yes` never ends by itself: done settles only because the stop killed it
  await expect(command.done).toResolve();
});

test('#encodeCommand fails the stream before FILE_END when the command fails', () => {
  const runner = createStreamRunner();

  const frames = encodeCommand(
    () => runner.readFrom(['sh', '-c', 'echo broken pipe >&2; exit 3']),
    { kind: 'zfs-stream', index: 0, sizeBytes: 0 },
    () => {},
    () => {},
  );

  expect(Array.fromAsync(frames)).rejects.toThrowWithMessage(
    Error,
    'sh -c echo broken pipe >&2; exit 3 exited 3: broken pipe',
  );
});
