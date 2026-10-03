import { expect, test } from 'bun:test';
import type { Image, ImageBuildPhase, ImageOpEvent } from '@imp/api';
import { runImageOp } from './image-op-stream';

const IMAGE: Image = {
  id: 'i1',
  name: 'web',
  ref: 'imp/web:latest',
  digest: 'sha256:x',
  source: 'oci',
  createdAt: new Date(0),
  sizeBytes: 1,
};

function setupTest(keepaliveMs = 10_000) {
  const records: unknown[] = [];
  const clock = { now: 0 };

  const options = {
    firstPhase: 'pull' as ImageBuildPhase,
    signal: new AbortController().signal,
    keepaliveMs,
    now: () => clock.now,
    record: (failure: unknown) => {
      records.push(failure);
    },
  };

  return { records, clock, options };
}

async function collectEvents(
  events: Readonly<AsyncIterable<ImageOpEvent>>,
): Promise<ImageOpEvent[]> {
  const seen: ImageOpEvent[] = [];

  for await (const event of events) {
    seen.push(event);
  }

  return seen;
}

test('progress at once and at each phase, then the image, audited as it ends', async () => {
  const ctx = setupTest();

  const events = await collectEvents(
    runImageOp(async (_, setPhase) => {
      await Bun.sleep(5);

      ctx.clock.now = 4000;

      setPhase('unpack');

      await Bun.sleep(5);

      return IMAGE;
    }, ctx.options),
  );

  expect(events).toEqual([
    { type: 'progress', phase: 'pull', elapsedMs: 0 },
    { type: 'progress', phase: 'unpack', elapsedMs: 4000 },
    { type: 'image', image: IMAGE },
  ]);

  expect(ctx.records).toEqual([null]);
});

test('a keepalive repeats the progress while the work is silent', async () => {
  const ctx = setupTest(10);

  const events = await collectEvents(
    runImageOp(async () => {
      await Bun.sleep(80);

      return IMAGE;
    }, ctx.options),
  );

  const progress = events.filter((event) => event.type === 'progress');

  expect(progress.length).toBeGreaterThan(3);
  expect(events.at(-1)).toEqual({ type: 'image', image: IMAGE });
});

test('a failure throws through the stream and is audited with what was thrown', async () => {
  const ctx = setupTest();

  const failure = new Error('pull denied');

  const thrown = await collectEvents(
    runImageOp(() => {
      throw failure;
    }, ctx.options),
  ).catch((error: unknown) => error);

  expect(thrown).toBe(failure);
  expect(ctx.records).toEqual([failure]);
});

test('work the client left still writes its audit row when it ends', async () => {
  const ctx = setupTest();
  const done = Promise.withResolvers<Image>();
  const events = runImageOp(() => done.promise, ctx.options);

  const first = await events.next();

  expect(first.value).toEqual({ type: 'progress', phase: 'pull', elapsedMs: 0 });

  // what oRPC does when the client goes: the stream ends at its yield
  await events.return(undefined);

  expect(ctx.records).toEqual([]);

  done.resolve(IMAGE);

  await Bun.sleep(0);

  expect(ctx.records).toEqual([null]);
});
