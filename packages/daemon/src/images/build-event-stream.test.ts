import { expect, onTestFinished, test } from 'bun:test';
import type { ImageBuildEvent } from '@imp/api';
import { IMAGE_BUILD_STREAM_TYPE } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createBuildEventStream, runOnInterval } from './build-event-stream';

test('#createBuildEventStream answers with the build stream content type', () => {
  const response = createBuildEventStream(
    new AbortController().signal,
    () => Promise.resolve({ type: 'error', code: 'BAD_REQUEST', message: 'no' }),
    { keepaliveMs: 10_000, now: () => 0 },
  );

  expect(response.headers.get('content-type')).toBe(IMAGE_BUILD_STREAM_TYPE);
});

test('#createBuildEventStream sends progress at once, then the event the build ends with', async () => {
  const response = createBuildEventStream(
    new AbortController().signal,
    () => Promise.resolve({ type: 'error', code: 'BAD_REQUEST', message: 'no' }),
    { keepaliveMs: 10_000, now: () => 0 },
  );

  const text = await response.text();

  expect(text).toBe(
    [
      JSON.stringify({ type: 'progress', phase: 'upload', elapsedMs: 0 }),
      JSON.stringify({ type: 'error', code: 'BAD_REQUEST', message: 'no' }),
      '',
    ].join('\n'),
  );
});

test('#createBuildEventStream sends progress as soon as the build moves to another phase', async () => {
  const clock = { now: 0 };

  const response = createBuildEventStream(
    new AbortController().signal,
    (_signal, setPhase) => {
      clock.now = 2500;

      setPhase('build');

      return Promise.resolve({ type: 'error', code: 'BAD_REQUEST', message: 'no' });
    },
    { keepaliveMs: 10_000, now: () => clock.now },
  );

  const text = await response.text();

  expect(text.split('\n')[1]).toBe(
    JSON.stringify({ type: 'progress', phase: 'build', elapsedMs: 2500 }),
  );
});

test('#createBuildEventStream repeats the progress at each keepalive while the build is silent', async () => {
  const clock = { now: 0 };
  const done = Promise.withResolvers<ImageBuildEvent>();
  const timers: { ms: number; tick: () => void }[] = [];

  const response = createBuildEventStream(new AbortController().signal, () => done.promise, {
    keepaliveMs: 15_000,
    now: () => clock.now,
    repeat: (ms, tick) => {
      timers.push({ ms, tick });

      return () => {};
    },
  });

  const timer = await waitFor(() => {
    invariant(timers[0]);

    return timers[0];
  });

  clock.now = 15_000;

  timer.tick();
  done.resolve({ type: 'error', code: 'BAD_REQUEST', message: 'no' });

  const text = await response.text();

  expect(timer.ms).toBe(15_000);

  expect(text.split('\n')[1]).toBe(
    JSON.stringify({ type: 'progress', phase: 'upload', elapsedMs: 15_000 }),
  );
});

test('#createBuildEventStream stops the keepalive when the build ends', async () => {
  const stopped = Promise.withResolvers<void>();

  const response = createBuildEventStream(
    new AbortController().signal,
    () => Promise.resolve({ type: 'error', code: 'BAD_REQUEST', message: 'no' }),
    {
      keepaliveMs: 10_000,
      now: () => 0,
      repeat: () => () => {
        stopped.resolve();
      },
    },
  );

  await response.text();

  expect(stopped.promise).resolves.toBeUndefined();
});

test('#createBuildEventStream stops the keepalive when the client goes', () => {
  const client = new AbortController();

  const stopped = Promise.withResolvers<void>();

  createBuildEventStream(client.signal, () => Promise.withResolvers<ImageBuildEvent>().promise, {
    keepaliveMs: 10_000,
    now: () => 0,
    repeat: () => () => {
      stopped.resolve();
    },
  });

  client.abort();

  expect(stopped.promise).resolves.toBeUndefined();
});

test('#createBuildEventStream aborts the build signal when the client cancels the stream', async () => {
  const seen = Promise.withResolvers<AbortSignal>();

  const response = createBuildEventStream(
    new AbortController().signal,
    (signal) => {
      seen.resolve(signal);

      return Promise.withResolvers<ImageBuildEvent>().promise;
    },
    { keepaliveMs: 10_000, now: () => 0 },
  );

  const signal = await seen.promise;

  await response.body?.cancel();

  expect(signal.aborted).toBeTrue();
});

test('#runOnInterval ticks a repeat again and again on its interval', async () => {
  const ticks: number[] = [];

  const stop = runOnInterval(1, () => {
    ticks.push(ticks.length);
  });

  onTestFinished(stop);

  await waitFor(() => {
    invariant(ticks[1]);
  });

  expect(ticks.slice(0, 2)).toStrictEqual([0, 1]);
});

// a served stream, as impd's route answers a build: the client goes between
// two progress lines
test('#createBuildEventStream sends nothing more and stops its keepalive once a served client leaves mid-stream', async () => {
  const ticks: (() => void)[] = [];
  const stopped = Promise.withResolvers<void>();

  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      createBuildEventStream(
        request.signal,
        () => Promise.withResolvers<ImageBuildEvent>().promise,
        {
          keepaliveMs: 10_000,
          now: () => 0,
          repeat: (_ms, tick) => {
            ticks.push(tick);

            return () => {
              stopped.resolve();
            };
          },
        },
      ),
  });

  onTestFinished(() => server.stop(true));

  const client = new AbortController();

  const response = await fetch(server.url, { signal: client.signal });

  const reader = response.body?.getReader();

  invariant(reader);

  await reader.read();

  client.abort();

  await stopped.promise;

  const [tick] = ticks;

  invariant(tick);

  expect(tick).not.toThrow();
});
