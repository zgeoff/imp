import { expect, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { buildStubTimer } from '../test-utils/build-stub-timer';
import { createPartPipe, sendInParts } from './move-parts';

test('#sendInParts splits the frames into bodies of at most the part size', async () => {
  const chunks = Array.from({ length: 7 }, (_unused, index) => new Uint8Array(10).fill(index));
  const sizes: number[] = [];

  const count = await sendInParts(
    (async function* encodeFrames() {
      yield* new Blob(chunks).stream();
    })(),
    async (_part, body) => {
      const bytes = await new Response(body).bytes();

      sizes.push(bytes.length);
    },
    25,
  );

  expect(count).toBe(3);
  expect(sizes).toStrictEqual([25, 25, 20]);
});

test('#createPartPipe joins the parts back into one stream in order', async () => {
  const chunks = Array.from({ length: 7 }, (_unused, index) => new Uint8Array(10).fill(index));
  const pipe = createPartPipe(1000);

  const joined = new Response(pipe.stream).bytes();

  await sendInParts(
    (async function* encodeFrames() {
      yield* new Blob(chunks).stream();
    })(),
    async (_part, body) => {
      const bytes = await new Response(body).bytes();

      await pipe.push(new Blob([bytes]).stream());
    },
    25,
  );

  pipe.end();

  const all = await joined;

  expect(Buffer.from(all)).toStrictEqual(Buffer.concat(chunks));
});

test('#sendInParts closes the frames when a post fails, so their files close', () => {
  const closed = { isClosed: false };
  const chunks = [new Uint8Array(30), new Uint8Array(30)];

  const frames = (async function* encodeFrames() {
    yield* new Blob(chunks).stream();
  })();

  const close = frames.return.bind(frames);

  frames.return = (value) => {
    closed.isClosed = true;

    return close(value);
  };

  const sent = sendInParts(frames, () => Promise.reject(new Error('the peer went away')), 10);

  expect(sent).rejects.toThrowWithMessage(Error, 'the peer went away');
  expect(closed.isClosed).toBe(true);
});

test('#createPartPipe gives up when the next part does not come before its deadline', async () => {
  const timer = buildStubTimer();
  const pipe = createPartPipe(20, timer);

  const read = new Response(pipe.stream).bytes();

  await waitFor(() => {
    expect(timer.countPending()).toBe(1);
  });

  timer.advance(21);

  expect(read).rejects.toThrowWithMessage(Error, 'the next part of the move stream did not come');
});

test('#createPartPipe keeps waiting for the next part until its deadline passes', async () => {
  const timer = buildStubTimer();
  const pipe = createPartPipe(20, timer);

  const read = new Response(pipe.stream).bytes();

  await waitFor(() => {
    expect(timer.countPending()).toBe(1);
  });

  // at the deadline, not past it: the pipe waits on
  timer.advance(20);

  await waitFor(() => {
    expect(timer.countPending()).toBe(1);
  });

  await pipe.push(new Blob([new Uint8Array([7])]).stream());

  pipe.end();

  const all = await read;

  expect(Buffer.from(all)).toStrictEqual(Buffer.from([7]));
});

test('#createPartPipe fails the stream and each waiting part with the error it is given', () => {
  const pipe = createPartPipe(1000);

  const read = new Response(pipe.stream).bytes();

  const pushed = pipe.push(new Blob([new Uint8Array(4)]).stream());

  pipe.fail(new Error('the source gave up'));

  expect(pushed).rejects.toThrowWithMessage(Error, 'the source gave up');
  expect(read).rejects.toThrowWithMessage(Error, 'the source gave up');
});
