import { expect, mock, test } from 'bun:test';
import { buildStubMoveStream } from './build-stub-move-stream';

test('it passes on every byte of its source and then closes', () => {
  const stream = buildStubMoveStream(new Blob(['a stream']).stream());

  expect(new Response(stream).text()).resolves.toBe('a stream');
});

test('it runs the end hook once after the last byte', async () => {
  const onEnd = mock(() => Promise.resolve());

  const text = await new Response(
    buildStubMoveStream(new Blob(['a stream']).stream(), { onEnd }),
  ).text();

  expect(text).toBe('a stream');
  expect(onEnd).toHaveBeenCalledOnce();
});

test('it holds the end of the stream until the end hook settles', async () => {
  const hook = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();

  const stream = buildStubMoveStream(new Blob(['a stream']).stream(), {
    onEnd: () => {
      reached.resolve();

      return hook.promise;
    },
  });

  const state = { isEnded: false };

  const reading = (async () => {
    await new Response(stream).text();

    state.isEnded = true;
  })();

  await reached.promise;

  const isEndedWhileHeld = state.isEnded;

  hook.resolve();

  await reading;

  expect(isEndedWhileHeld).toBeFalse();
  expect(state.isEnded).toBeTrue();
});

test('it fails with the given error after the last byte', async () => {
  const reader = buildStubMoveStream(new Blob(['a stream']).stream(), {
    failAtEnd: new Error('the sum does not match'),
  }).getReader();

  const first = await reader.read();

  expect(new TextDecoder().decode(first.value)).toBe('a stream');
  expect(reader.read()).rejects.toThrowWithMessage(Error, 'the sum does not match');
});

test('it fails at its first read when its source is empty', () => {
  const stream = buildStubMoveStream(new Blob([]).stream(), {
    failAtEnd: new Error('the stream broke'),
  });

  expect(new Response(stream).text()).rejects.toThrowWithMessage(Error, 'the stream broke');
});
