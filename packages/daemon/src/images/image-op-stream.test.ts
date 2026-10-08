import { expect, test } from 'bun:test';
import type { Image } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { runImageOp } from './image-op-stream';

test('it sends progress at once and at each phase, then the image', async () => {
  const clock = { now: 0 };
  const phaseReached = Promise.withResolvers<void>();
  const done = Promise.withResolvers<Image>();

  const events = runImageOp(
    async (_signal, setPhase) => {
      await phaseReached.promise;

      clock.now = 4000;

      setPhase('unpack');

      return done.promise;
    },
    {
      firstPhase: 'pull',
      signal: new AbortController().signal,
      keepaliveMs: 10_000,
      now: () => clock.now,
      record: () => {},
    },
  );

  const first = await events.next();

  phaseReached.resolve();

  const second = await events.next();

  done.resolve({
    id: 'i1',
    name: 'web',
    ref: 'imp/web:latest',
    digest: 'sha256:x',
    source: 'oci',
    createdAt: new Date(0),
    sizeBytes: 1,
  });

  const third = await events.next();

  expect([first.value, second.value, third.value]).toStrictEqual([
    { type: 'progress', phase: 'pull', elapsedMs: 0 },
    { type: 'progress', phase: 'unpack', elapsedMs: 4000 },
    {
      type: 'image',
      image: {
        id: 'i1',
        name: 'web',
        ref: 'imp/web:latest',
        digest: 'sha256:x',
        source: 'oci',
        createdAt: new Date(0),
        sizeBytes: 1,
      },
    },
  ]);
});

test('it records a null failure for work that ends with its image', async () => {
  const records: unknown[] = [];

  await Array.fromAsync(
    runImageOp(
      () =>
        Promise.resolve({
          id: 'i1',
          name: 'web',
          ref: 'imp/web:latest',
          digest: 'sha256:x',
          source: 'oci' as const,
          createdAt: new Date(0),
          sizeBytes: 1,
        }),
      {
        firstPhase: 'pull',
        signal: new AbortController().signal,
        keepaliveMs: 10_000,
        now: () => 0,
        record: (failure) => {
          records.push(failure);
        },
      },
    ),
  );

  expect(records).toStrictEqual([null]);
});

test('it repeats the progress at each keepalive while the work is silent', async () => {
  const clock = { now: 0 };
  const timers: { ms: number; tick: () => void }[] = [];

  const events = runImageOp(() => Promise.withResolvers<Image>().promise, {
    firstPhase: 'pull',
    signal: new AbortController().signal,
    keepaliveMs: 15_000,
    now: () => clock.now,
    record: () => {},
    repeat: (ms, tick) => {
      timers.push({ ms, tick });

      return () => {};
    },
  });

  await events.next();

  const second = events.next();

  const timer = await waitFor(() => {
    invariant(timers[0]);

    return timers[0];
  });

  clock.now = 15_000;

  timer.tick();

  const keepalive = await second;

  expect(timer.ms).toBe(15_000);
  expect(keepalive.value).toStrictEqual({ type: 'progress', phase: 'pull', elapsedMs: 15_000 });
});

test('it throws the failure through the stream and records what was thrown', () => {
  const records: unknown[] = [];

  const failure = new Error('pull denied');

  const collected = Array.fromAsync(
    runImageOp(() => Promise.reject(failure), {
      firstPhase: 'pull',
      signal: new AbortController().signal,
      keepaliveMs: 10_000,
      now: () => 0,
      record: (recorded) => {
        records.push(recorded);
      },
    }),
  );

  expect(collected).rejects.toBe(failure);
  expect(records).toStrictEqual([failure]);
});

// what oRPC does when the client goes: the stream ends at its yield
test('it writes no audit row when the client leaves before the work ends', async () => {
  const records: unknown[] = [];

  const events = runImageOp(() => Promise.withResolvers<Image>().promise, {
    firstPhase: 'pull',
    signal: new AbortController().signal,
    keepaliveMs: 10_000,
    now: () => 0,
    record: (failure) => {
      records.push(failure);
    },
  });

  await events.next();
  await events.return(undefined);

  expect(records).toStrictEqual([]);
});

test('it writes the audit row of work the client left once the work ends', async () => {
  const recorded = Promise.withResolvers<unknown>();
  const done = Promise.withResolvers<Image>();

  const events = runImageOp(() => done.promise, {
    firstPhase: 'pull',
    signal: new AbortController().signal,
    keepaliveMs: 10_000,
    now: () => 0,
    record: (failure) => {
      recorded.resolve(failure);
    },
  });

  await events.next();
  await events.return(undefined);

  done.resolve({
    id: 'i1',
    name: 'web',
    ref: 'imp/web:latest',
    digest: 'sha256:x',
    source: 'oci',
    createdAt: new Date(0),
    sizeBytes: 1,
  });

  expect(recorded.promise).resolves.toBeNull();
});

test('it stops the keepalive timer once the work ends', async () => {
  const done = Promise.withResolvers<Image>();
  const stopped = Promise.withResolvers<void>();

  const events = runImageOp(() => done.promise, {
    firstPhase: 'pull',
    signal: new AbortController().signal,
    keepaliveMs: 10_000,
    now: () => 0,
    record: () => {},
    repeat: () => () => {
      stopped.resolve();
    },
  });

  await events.next();

  const image = events.next();

  done.resolve({
    id: 'i1',
    name: 'web',
    ref: 'imp/web:latest',
    digest: 'sha256:x',
    source: 'oci',
    createdAt: new Date(0),
    sizeBytes: 1,
  });

  await image;

  expect(stopped.promise).resolves.toBeUndefined();
});

test('it stops the keepalive timer of a wait the next phase ends', async () => {
  const stops: number[] = [];
  const phases: ((phase: 'unpack') => void)[] = [];

  const events = runImageOp(
    (_signal, setPhase) => {
      phases.push(setPhase);

      return Promise.withResolvers<Image>().promise;
    },
    {
      firstPhase: 'pull',
      signal: new AbortController().signal,
      keepaliveMs: 10_000,
      now: () => 0,
      record: () => {},
      repeat: () => () => {
        stops.push(stops.length);
      },
    },
  );

  await events.next();

  const next = events.next();

  const setPhase = await waitFor(() => {
    invariant(phases[0]);

    return phases[0];
  });

  setPhase('unpack');

  await next;

  expect(stops).toStrictEqual([0]);
});
