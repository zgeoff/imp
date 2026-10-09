import { expect, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { MOVE_FRAMES, encodeJsonFrame, readJsonPayload } from '../moves/move-frames';
import { MOVE_FINISH_HEADER, MOVE_PART_HEADER, MOVE_PATHS } from '../moves/move-header';
import { TARGET_URL, setupMoveHosts } from '../moves/test-moves';
import { buildJsonMoveFrame, buildStubMoveStreamRewrite } from './build-stub-move-stream-rewrite';
import type { MoveFrame } from './build-stub-move-stream-rewrite';

// the hosts a hook is handed; the rewrite reads none of them
function setupTest() {
  return setupMoveHosts();
}

test('it builds a frame whose payload is the value as JSON', () => {
  const frame = buildJsonMoveFrame(MOVE_FRAMES.end, { sha256: 'ab' });

  expect(frame.type).toBe(MOVE_FRAMES.end);
  expect(readJsonPayload(frame.payload)).toStrictEqual({ sha256: 'ab' });
});

test('it hands the rewrite the frames of the first part, decoded', async () => {
  const ctx = await setupTest();

  const seen: (readonly MoveFrame[])[] = [];

  const hook = buildStubMoveStreamRewrite((frames) => {
    seen.push(frames);

    return frames;
  });

  const header = encodeJsonFrame(MOVE_FRAMES.header, { version: 1 });
  const end = encodeJsonFrame(MOVE_FRAMES.end, {});

  const request = new Request(`${TARGET_URL}${MOVE_PATHS.receive}`, {
    method: 'POST',
    headers: { [MOVE_PART_HEADER]: '0' },
    body: new Blob([header, end]),
  });

  await hook(request, () => Promise.resolve(new Response(null, { status: 202 })), ctx);

  expect(seen).toStrictEqual([
    [
      buildJsonMoveFrame(MOVE_FRAMES.header, { version: 1 }),
      buildJsonMoveFrame(MOVE_FRAMES.end, {}),
    ],
  ]);
});

test('it forwards the rewritten frames as the body of the first part', async () => {
  const ctx = await setupTest();

  const forwarded: (Request | undefined)[] = [];
  const header = encodeJsonFrame(MOVE_FRAMES.header, { version: 1 });
  const end = encodeJsonFrame(MOVE_FRAMES.end, {});

  const request = new Request(`${TARGET_URL}${MOVE_PATHS.receive}`, {
    method: 'POST',
    headers: { [MOVE_PART_HEADER]: '0' },
    body: new Blob([header, end]),
  });

  await buildStubMoveStreamRewrite((frames) => frames.slice(1))(
    request,
    (replacement) => {
      forwarded.push(replacement);

      return Promise.resolve(new Response(null, { status: 202 }));
    },
    ctx,
  );

  const [sent] = forwarded;

  invariant(sent);

  const body = await sent.arrayBuffer();

  expect(forwarded).toHaveLength(1);
  expect(sent.headers.get(MOVE_PART_HEADER)).toBe('0');
  expect(new Uint8Array(body)).toStrictEqual(new Uint8Array(encodeJsonFrame(MOVE_FRAMES.end, {})));
});

test('it forwards a finish as sent', async () => {
  const ctx = await setupTest();

  const forwarded: (Request | undefined)[] = [];

  const request = new Request(`${TARGET_URL}${MOVE_PATHS.receive}`, {
    method: 'POST',
    headers: { [MOVE_FINISH_HEADER]: '1' },
  });

  await buildStubMoveStreamRewrite(() => [])(
    request,
    (replacement) => {
      forwarded.push(replacement);

      return Promise.resolve(new Response(null));
    },
    ctx,
  );

  expect(forwarded).toStrictEqual([undefined]);
});

test('it forwards a request to another route as sent', async () => {
  const ctx = await setupTest();

  const forwarded: (Request | undefined)[] = [];

  const request = new Request(`${TARGET_URL}${MOVE_PATHS.commit}`, { method: 'POST' });

  await buildStubMoveStreamRewrite(() => [])(
    request,
    (replacement) => {
      forwarded.push(replacement);

      return Promise.resolve(new Response(null));
    },
    ctx,
  );

  expect(forwarded).toStrictEqual([undefined]);
});

test('it fails a stream that comes in more than one part', async () => {
  const ctx = await setupTest();

  const request = new Request(`${TARGET_URL}${MOVE_PATHS.receive}`, {
    method: 'POST',
    headers: { [MOVE_PART_HEADER]: '1' },
    body: new Uint8Array([1]),
  });

  const sent = buildStubMoveStreamRewrite((frames) => frames)(
    request,
    () => Promise.resolve(new Response(null)),
    ctx,
  );

  expect(sent).rejects.toThrowWithMessage(
    Error,
    'the stream rewrite needs the whole stream in part 0, not part 1',
  );
});
