import { expect, test } from 'bun:test';
import type { Image } from '@imp/api';
import { buildMockImage } from '@imp/api/test-utils/build-mock-image';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { buildStubRepeat } from '../test-utils/build-stub-repeat';
import { runImageOp } from './image-op-stream';

test('it sends progress at once and at each phase, then the image', async () => {
  const clock = { now: 0 };
  const phaseReached = Promise.withResolvers<void>();
  const done = Promise.withResolvers<Image>();
  const image = buildMockImage();

  const events = runImageOp(
    async (_signal, report) => {
      await phaseReached.promise;

      clock.now = 4000;

      report.setPhase('unpack');

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

  done.resolve(image);

  const third = await events.next();

  expect([first.value, second.value, third.value]).toStrictEqual([
    { type: 'progress', phase: 'pull', elapsedMs: 0 },
    { type: 'progress', phase: 'unpack', elapsedMs: 4000 },
    { type: 'image', image },
  ]);
});

test('it records a null failure for work that ends with its image', async () => {
  const records: unknown[] = [];

  await Array.fromAsync(
    runImageOp(() => Promise.resolve(buildMockImage()), {
      firstPhase: 'pull',
      signal: new AbortController().signal,
      keepaliveMs: 10_000,
      now: () => 0,
      record: (failure) => {
        records.push(failure);
      },
    }),
  );

  expect(records).toStrictEqual([null]);
});

test('it repeats the progress at each keepalive while the work is silent', async () => {
  const clock = { now: 0 };
  const keepalive = buildStubRepeat();

  const events = runImageOp(() => Promise.withResolvers<Image>().promise, {
    firstPhase: 'pull',
    signal: new AbortController().signal,
    keepaliveMs: 15_000,
    now: () => clock.now,
    record: () => {},
    repeat: keepalive.repeat,
  });

  await events.next();

  const second = events.next();

  await waitFor(() => {
    expect(keepalive.countRunning(15_000)).toBe(1);
  });

  clock.now = 15_000;

  keepalive.tick(15_000);

  const progress = await second;

  expect(progress.value).toStrictEqual({ type: 'progress', phase: 'pull', elapsedMs: 15_000 });
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

  done.resolve(buildMockImage());

  expect(recorded.promise).resolves.toBeNull();
});

test('it stops the keepalive timer once the work ends', async () => {
  const done = Promise.withResolvers<Image>();
  const keepalive = buildStubRepeat();

  const events = runImageOp(() => done.promise, {
    firstPhase: 'pull',
    signal: new AbortController().signal,
    keepaliveMs: 10_000,
    now: () => 0,
    record: () => {},
    repeat: keepalive.repeat,
  });

  await events.next();

  const imageEvent = events.next();

  await waitFor(() => {
    expect(keepalive.countRunning(10_000)).toBe(1);
  });

  done.resolve(buildMockImage());

  await imageEvent;

  expect(keepalive.countRunning(10_000)).toBe(0);
});

test('it stops the keepalive timer of a wait the next phase ends', async () => {
  const phases: ((phase: 'unpack') => void)[] = [];
  const keepalive = buildStubRepeat();

  const events = runImageOp(
    (_signal, report) => {
      phases.push(report.setPhase);

      return Promise.withResolvers<Image>().promise;
    },
    {
      firstPhase: 'pull',
      signal: new AbortController().signal,
      keepaliveMs: 10_000,
      now: () => 0,
      record: () => {},
      repeat: keepalive.repeat,
    },
  );

  await events.next();

  const next = events.next();

  const setPhase = await waitFor(() => {
    invariant(phases[0]);

    return phases[0];
  });

  await waitFor(() => {
    expect(keepalive.countRunning(10_000)).toBe(1);
  });

  setPhase('unpack');

  await next;

  expect(keepalive.countRunning(10_000)).toBe(0);
});

test('it sends the build output as log events in order, before the image', async () => {
  const image = buildMockImage();

  const events = await Array.fromAsync(
    runImageOp(
      (_signal, report) => {
        report.output.emitLog('#4 [2/3] RUN make all');
        report.output.emitLog('#4 cc -o widget main.c');

        return Promise.resolve(image);
      },
      {
        firstPhase: 'build',
        signal: new AbortController().signal,
        keepaliveMs: 10_000,
        now: () => 0,
        record: () => {},
        logs: true,
      },
    ),
  );

  expect(events).toStrictEqual([
    { type: 'progress', phase: 'build', elapsedMs: 0 },
    { type: 'log', text: '#4 [2/3] RUN make all' },
    { type: 'log', text: '#4 cc -o widget main.c' },
    { type: 'image', image },
  ]);
});

test('it sends progress with the step the build reached while it runs', async () => {
  const done = Promise.withResolvers<Image>();
  const reports: ((step: string) => void)[] = [];

  const events = runImageOp(
    (_signal, report) => {
      reports.push(report.output.setStep);

      return done.promise;
    },
    {
      firstPhase: 'build',
      signal: new AbortController().signal,
      keepaliveMs: 10_000,
      now: () => 0,
      record: () => {},
    },
  );

  await events.next();

  const next = events.next();

  const setStep = await waitFor(() => {
    invariant(reports[0]);

    return reports[0];
  });

  setStep('[3/3] RUN make install');

  const second = await next;

  done.resolve(buildMockImage());

  expect(second.value).toStrictEqual({
    type: 'progress',
    phase: 'build',
    elapsedMs: 0,
    step: '[3/3] RUN make install',
  });
});

test('it sends no log events to a client that did not ask for them', async () => {
  const image = buildMockImage();

  const events = await Array.fromAsync(
    runImageOp(
      (_signal, report) => {
        report.output.emitLog('#4 cc -o widget main.c');

        return Promise.resolve(image);
      },
      {
        firstPhase: 'build',
        signal: new AbortController().signal,
        keepaliveMs: 10_000,
        now: () => 0,
        record: () => {},
      },
    ),
  );

  expect(events).toStrictEqual([
    { type: 'progress', phase: 'build', elapsedMs: 0 },
    { type: 'image', image },
  ]);
});
