import { expect, mock, test } from 'bun:test';
import { IMAGE_BUILD_STREAM_TYPE } from '@imp/api';
import type { ImageBuildProgress } from '@imp/api';
import { buildMockImage } from '@imp/api/test-utils/build-mock-image';
import { ORPCError } from '@orpc/client';
import { readBuildAnswer } from './read-build-answer';

// Answers a real impd never sends, from a newer impd, a proxy in front of
// impd or a dropped connection. build-image.test.ts reads impd's own.

test('it skips a line it does not know and reads on to the image', async () => {
  const image = buildMockImage({ name: 'web' });
  const progress = mock<(event: ImageBuildProgress) => void>();

  const answer = new Response(
    [
      '{"type":"from-a-newer-impd"}',
      '{"type":"progress","phase":"build","elapsedMs":15000}',
      JSON.stringify({ type: 'image', image }),
      '',
    ].join('\n'),
    { headers: { 'content-type': IMAGE_BUILD_STREAM_TYPE } },
  );

  const built = await readBuildAnswer(answer, progress);

  expect(built).toStrictEqual(image);

  expect(progress).toHaveBeenCalledExactlyOnceWith({
    type: 'progress',
    phase: 'build',
    elapsedMs: 15_000,
  });
});

test('it hands each log line to onLog and progress with its step to onProgress', async () => {
  const image = buildMockImage({ name: 'web' });
  const progress = mock<(event: ImageBuildProgress) => void>();
  const log = mock<(line: string) => void>();

  const answer = new Response(
    [
      '{"type":"log","text":"#4 [2/3] RUN make all"}',
      '{"type":"progress","phase":"build","elapsedMs":3000,"step":"[2/3] RUN make all"}',
      '{"type":"log","text":"#4 0.31 cc -o widget main.c"}',
      JSON.stringify({ type: 'image', image }),
      '',
    ].join('\n'),
    { headers: { 'content-type': IMAGE_BUILD_STREAM_TYPE } },
  );

  await readBuildAnswer(answer, progress, log);

  expect(log.mock.calls).toStrictEqual([
    ['#4 [2/3] RUN make all'],
    ['#4 0.31 cc -o widget main.c'],
  ]);

  expect(progress).toHaveBeenCalledExactlyOnceWith({
    type: 'progress',
    phase: 'build',
    elapsedMs: 3000,
    step: '[2/3] RUN make all',
  });
});

test('it throws INTERNAL_SERVER_ERROR for a stream cut short before the image', () => {
  const answer = new Response('{"type":"progress","phase":"build","elapsedMs":15000}\n', {
    headers: { 'content-type': IMAGE_BUILD_STREAM_TYPE },
  });

  expect(readBuildAnswer(answer, undefined)).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'the image build stream ended before impd answered the image',
  });
});

test('it throws INTERNAL_SERVER_ERROR with the status of a failure that names no code', () => {
  const answer = new Response('bad gateway', { status: 502 });

  const reading = readBuildAnswer(answer, undefined);

  expect(reading).rejects.toBeInstanceOf(ORPCError);

  expect(reading).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
    status: 502,
    message: 'impd answered 502 to the image build',
  });
});

test('it throws UNAUTHORIZED for a 401 that names no code', () => {
  const answer = new Response(null, { status: 401 });

  expect(readBuildAnswer(answer, undefined)).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
    status: 401,
    message: 'impd answered 401 to the image build',
  });
});
