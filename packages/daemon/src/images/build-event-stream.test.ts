import { expect, onTestFinished, test } from 'bun:test';
import type { ImageBuildEvent } from '@impz/api';
import { IMAGE_BUILD_STREAM_TYPE, ImageBuildEventSchema } from '@impz/api';
import { invariant } from '@impz/test-utils/invariant';
import { waitFor } from '@impz/test-utils/wait-for';
import { buildStubRepeat } from '../test-utils/build-stub-repeat';
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
    (_signal, report) => {
      clock.now = 2500;

      report.setPhase('build');

      return Promise.resolve({ type: 'error', code: 'BAD_REQUEST', message: 'no' });
    },
    { keepaliveMs: 10_000, now: () => clock.now },
  );

  const text = await response.text();

  expect(text.split('\n')[1]).toBe(
    JSON.stringify({ type: 'progress', phase: 'build', elapsedMs: 2500 }),
  );
});

test('#createBuildEventStream sends progress with the step as soon as a step starts', async () => {
  const clock = { now: 0 };

  const response = createBuildEventStream(
    new AbortController().signal,
    (_signal, report) => {
      report.setPhase('build');

      clock.now = 4000;

      report.output.setStep('[2/3] RUN make all');

      return Promise.resolve({ type: 'error', code: 'BAD_REQUEST', message: 'no' });
    },
    { keepaliveMs: 10_000, now: () => clock.now },
  );

  const text = await response.text();

  expect(text.split('\n')[2]).toBe(
    JSON.stringify({
      type: 'progress',
      phase: 'build',
      elapsedMs: 4000,
      step: '[2/3] RUN make all',
    }),
  );
});

test('#createBuildEventStream sends each line of the build output as a log event, in order', async () => {
  const response = createBuildEventStream(
    new AbortController().signal,
    (_signal, report) => {
      report.output.emitLog('#5 [2/3] RUN make all');
      report.output.emitLog('#5 cc -o widget main.c');

      return Promise.resolve({ type: 'error', code: 'BAD_REQUEST', message: 'no' });
    },
    { keepaliveMs: 10_000, now: () => 0 },
  );

  const text = await response.text();

  expect(text).toBe(
    [
      JSON.stringify({ type: 'progress', phase: 'upload', elapsedMs: 0 }),
      JSON.stringify({ type: 'log', text: '#5 [2/3] RUN make all' }),
      JSON.stringify({ type: 'log', text: '#5 cc -o widget main.c' }),
      JSON.stringify({ type: 'error', code: 'BAD_REQUEST', message: 'no' }),
      '',
    ].join('\n'),
  );
});

test('#createBuildEventStream repeats the progress at each keepalive while the build is silent', async () => {
  const clock = { now: 0 };
  const done = Promise.withResolvers<ImageBuildEvent>();
  const keepalive = buildStubRepeat();

  const response = createBuildEventStream(new AbortController().signal, () => done.promise, {
    keepaliveMs: 15_000,
    now: () => clock.now,
    repeat: keepalive.repeat,
  });

  await waitFor(() => {
    expect(keepalive.countRunning(15_000)).toBe(1);
  });

  clock.now = 15_000;

  keepalive.tick(15_000);
  done.resolve({ type: 'error', code: 'BAD_REQUEST', message: 'no' });

  const text = await response.text();

  expect(text.split('\n')[1]).toBe(
    JSON.stringify({ type: 'progress', phase: 'upload', elapsedMs: 15_000 }),
  );
});

// 400 s of a silent build: past the 360 s Bun's fetch waits for a byte
test('#createBuildEventStream sends progress every 15 s through a build silent for 400 s', async () => {
  const clock = { now: 0 };
  const done = Promise.withResolvers<ImageBuildEvent>();
  const keepalive = buildStubRepeat();

  const response = createBuildEventStream(new AbortController().signal, () => done.promise, {
    keepaliveMs: 15_000,
    now: () => clock.now,
    repeat: keepalive.repeat,
  });

  await waitFor(() => {
    expect(keepalive.countRunning(15_000)).toBe(1);
  });

  for (const tick of Array.from({ length: 27 }, (_, index) => index + 1)) {
    clock.now = tick * 15_000;

    keepalive.tick(15_000);
  }

  done.resolve({ type: 'error', code: 'BAD_REQUEST', message: 'no' });

  const text = await response.text();

  expect(text.split('\n').slice(1, 28)).toStrictEqual(
    Array.from({ length: 27 }, (_, index) =>
      JSON.stringify({ type: 'progress', phase: 'upload', elapsedMs: (index + 1) * 15_000 }),
    ),
  );
});

test('#createBuildEventStream stops the keepalive when the build ends', async () => {
  const done = Promise.withResolvers<ImageBuildEvent>();
  const keepalive = buildStubRepeat();

  const response = createBuildEventStream(new AbortController().signal, () => done.promise, {
    keepaliveMs: 10_000,
    now: () => 0,
    repeat: keepalive.repeat,
  });

  await waitFor(() => {
    expect(keepalive.countRunning(10_000)).toBe(1);
  });

  done.resolve({ type: 'error', code: 'BAD_REQUEST', message: 'no' });

  await response.text();

  expect(keepalive.countRunning(10_000)).toBe(0);
});

test('#createBuildEventStream stops the keepalive when the client goes', async () => {
  const client = new AbortController();

  const keepalive = buildStubRepeat();

  createBuildEventStream(client.signal, () => Promise.withResolvers<ImageBuildEvent>().promise, {
    keepaliveMs: 10_000,
    now: () => 0,
    repeat: keepalive.repeat,
  });

  await waitFor(() => {
    expect(keepalive.countRunning(10_000)).toBe(1);
  });

  client.abort();

  await waitFor(() => {
    expect(keepalive.countRunning(10_000)).toBe(0);
  });
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
  const keepalive = buildStubRepeat();

  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      createBuildEventStream(
        request.signal,
        () => Promise.withResolvers<ImageBuildEvent>().promise,
        { keepaliveMs: 10_000, now: () => 0, repeat: keepalive.repeat },
      ),
  });

  onTestFinished(() => server.stop(true));

  const client = new AbortController();

  const response = await fetch(server.url, { signal: client.signal });

  const reader = response.body?.getReader();

  invariant(reader);

  await reader.read();

  client.abort();

  await waitFor(() => {
    expect(keepalive.countRunning(10_000)).toBe(0);
  });

  // the stopped keepalive's tick, as an interval that fell due as it stopped
  const [tick] = keepalive.listStartedTicks(10_000);

  invariant(tick);

  expect(tick).not.toThrow();
});

test('#createBuildEventStream holds at most 1 MiB of build output for a client that has not read, and counts what it dropped', async () => {
  const response = createBuildEventStream(
    new AbortController().signal,
    (_signal, report) => {
      for (let line = 0; line < 4096; line += 1) {
        report.output.emitLog('x'.repeat(8000));
      }

      return Promise.resolve({ type: 'error', code: 'BAD_REQUEST', message: 'no' });
    },
    { keepaliveMs: 10_000, now: () => 0 },
  );

  const text = await response.text();

  const events = text
    .trim()
    .split('\n')
    .map((line) => ImageBuildEventSchema.parse(JSON.parse(line)));

  const kept = events.filter((event) => event.type === 'log' && event.text.startsWith('x'));
  const marker = events.at(-2);

  expect(Buffer.byteLength(text)).toBeLessThan(1024 ** 2 + 16_384);
  expect(kept.length).toBeGreaterThan(0);

  expect(marker).toStrictEqual({
    type: 'log',
    text: `imp: ${String(4096 - kept.length)} lines of build output dropped: the client read them more slowly than the build wrote them`,
  });

  expect(events.at(-1)).toStrictEqual({ type: 'error', code: 'BAD_REQUEST', message: 'no' });
});
