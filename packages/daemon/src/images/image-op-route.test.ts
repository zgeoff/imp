import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImageOpEvent } from '@imp/api';
import { listApiCalls } from '../db/api-audit';
import { createImage } from '../db/images';
import { TEST_TOKEN, buildTestApp, setupImpTest } from '../imps/test-imps';
import type { ImageService } from './image-service';

type ImageOverrides = Partial<Pick<ImageService, 'addImage' | 'buildImage'>>;

// impd in-process, with these in place of the image service's own
async function setupTest(
  overrides: ImageOverrides = {},
  env: Readonly<Record<string, string>> = {},
) {
  const harness = await setupImpTest({ env });

  const images = { ...harness.images, ...overrides };

  const buildApp = (token: string) =>
    buildTestApp({ ...harness, images }, harness, token, {}, null, {}, 10);

  const root = buildApp(TEST_TOKEN);

  // every audit row of the procedure, oldest first, once there are `count`
  const readOutcomes = async (procedure: string, count: number) => {
    const deadline = Date.now() + 5000;

    for (;;) {
      const rows = await listApiCalls(harness.db, null, 100, null);

      const calls = rows.filter((row) => row.procedure === procedure).toReversed();

      if (calls.length >= count || Date.now() > deadline) {
        return calls.map((row) => ({ outcome: row.outcome, imp: row.imp ?? null }));
      }

      await Bun.sleep(5);
    }
  };

  const makeImage = (name: string) =>
    createImage(harness.db, { name, ref: `imp/${name}:latest`, digest: 'sha256:x', sizeBytes: 1 });

  return {
    harness,
    client: root.client,
    buildApp,
    readOutcomes,
    makeImage,
    [Symbol.asyncDispose]: () => harness[Symbol.asyncDispose](),
  };
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

// a call to its end, failed or not: an aborted one fails
async function waitForEnd(call: Promise<unknown>): Promise<void> {
  try {
    await call;
  } catch {}
}

function readPhases(events: readonly ImageOpEvent[]): string[] {
  const phases = events.flatMap((event) => (event.type === 'progress' ? [event.phase] : []));

  return phases.filter((phase, index) => phases[index - 1] !== phase);
}

test('images.addStream yields its phases, then the image, and audits the outcome as it ends', async () => {
  await using ctx = await setupTest({
    addImage: async (ref, name, options) => {
      await Bun.sleep(30);

      options?.setPhase?.('unpack');

      await Bun.sleep(30);

      return ctx.makeImage(name ?? ref);
    },
  });

  const stream = await ctx.client.images.addStream({ ref: 'busybox:1.37', name: 'box' });
  const events = await collectEvents(stream);

  expect(readPhases(events)).toEqual(['pull', 'unpack']);
  expect(events.at(-1)).toMatchObject({ type: 'image', image: { name: 'box' } });
  expect(events.at(-1)).toHaveProperty('image.createdAt', expect.any(Date));

  const outcomes = await ctx.readOutcomes('images.addStream', 1);

  expect(outcomes).toEqual([{ outcome: 'ok', imp: null }]);
});

test("a streamed add's audit row keeps the reference its pull resolved", async () => {
  const pulled = `busybox@sha256:${'b'.repeat(64)}`;

  await using ctx = await setupTest({
    addImage: (ref, name, options) => {
      options?.onResolved?.(pulled);

      return ctx.makeImage(name ?? ref);
    },
  });

  const stream = await ctx.client.images.addStream({ ref: 'busybox', name: 'box' });

  await collectEvents(stream);

  await ctx.readOutcomes('images.addStream', 1);

  const rows = await listApiCalls(ctx.harness.db, null, 10, null);

  const adds = rows.filter((row) => row.procedure === 'images.addStream');

  expect(adds.map((row) => row.detail)).toEqual([pulled]);
});

test('a template streams its copy and is audited with its imp', async () => {
  await using ctx = await setupTest();

  await ctx.harness.createTestImage('base');
  await ctx.client.imps.create({ name: 'source' });

  const stream = await ctx.client.images.addStream({ imp: 'source', name: 'tpl' });
  const events = await collectEvents(stream);

  expect(readPhases(events)).toEqual(['copy']);
  expect(events.at(-1)).toMatchObject({ type: 'image', image: { name: 'tpl', source: 'imp' } });

  const outcomes = await ctx.readOutcomes('images.addStream', 1);

  expect(outcomes).toEqual([{ outcome: 'ok', imp: 'source' }]);
});

test('a failed add throws its error through the stream and is audited with its code', async () => {
  await using ctx = await setupTest({
    addImage: () => Promise.reject(new Error('pull denied')),
  });

  const thrown = await ctx.client.images
    .addStream({ ref: 'busybox:1.37' })
    .then(collectEvents)
    .catch((error: unknown) => error);

  // a failure that is not an ORPCError keeps its message out of the answer,
  // as for images.add
  expect(thrown).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

  const outcomes = await ctx.readOutcomes('images.addStream', 1);

  expect(outcomes).toEqual([{ outcome: 'INTERNAL_SERVER_ERROR', imp: null }]);
});

test('a refused stream call is audited, as any refused call', async () => {
  await using ctx = await setupTest();

  const made = await ctx.client.tokens.create({ name: 'reader', scope: 'read' });

  const reader = ctx.buildApp(made.secret).client;

  const refusals = await Promise.all([
    reader.images.addStream({ ref: 'busybox:1.37' }).catch((error: unknown) => error),
    reader.images
      .buildStream({ contextDir: '/srv/ctx', name: 'web' })
      .catch((error: unknown) => error),
  ]);

  expect(refusals).toMatchObject([{ code: 'FORBIDDEN' }, { code: 'FORBIDDEN' }]);

  const outcomes = [
    ...(await ctx.readOutcomes('images.addStream', 1)),
    ...(await ctx.readOutcomes('images.buildStream', 1)),
  ];

  expect(outcomes.map((row) => row.outcome)).toEqual(['FORBIDDEN', 'FORBIDDEN']);
});

test('images.buildStream packs, then builds; a client that goes stops the build', async () => {
  const stopped = Promise.withResolvers<void>();

  await using ctx = await setupTest({
    buildImage: async (_contextDir, _name, _dockerfile, options) => {
      await Bun.sleep(20);

      options?.setPhase?.('build');
      const signal = options?.signal;

      if (signal === undefined) {
        throw new Error('no signal');
      }

      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve);
      });

      stopped.resolve();
      throw signal.reason;
    },
  });

  const client = new AbortController();

  const events = await ctx.client.images.buildStream(
    { contextDir: '/srv/ctx', name: 'web' },
    { signal: client.signal },
  );

  const seen: string[] = [];

  for await (const event of events) {
    if (event.type === 'progress') {
      seen.push(event.phase);

      if (event.phase === 'build') {
        break;
      }
    }
  }

  client.abort();

  await stopped.promise;

  expect(seen[0]).toBe('pack');
  expect(seen.at(-1)).toBe('build');

  const outcomes = await ctx.readOutcomes('images.buildStream', 1);

  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]?.outcome).not.toBe('ok');
});

test('a client that goes stops the pull of an add on the host', async () => {
  await using ctx = await setupTest({}, { IMP_BUILD_ISOLATION: 'host' });

  // a docker whose inspect finds nothing and whose pull hangs until killed
  const bin = join(ctx.harness.config.dataDir, 'fake-bin');
  const log = join(ctx.harness.config.dataDir, 'docker.log');

  mkdirSync(bin, { recursive: true });

  writeFileSync(
    join(bin, 'docker'),
    ['#!/bin/sh', `echo "$1" >>'${log}'`, '[ "$1" = pull ] && exec sleep 30', 'exit 1'].join('\n'),
    { mode: 0o755 },
  );

  const savedPath = process.env['PATH'];

  process.env['PATH'] = `${bin}:${savedPath ?? ''}`;

  try {
    const client = new AbortController();

    const events = await ctx.client.images.addStream(
      { ref: 'registry.test/big:1' },
      { signal: client.signal },
    );

    await events.next();

    while (!existsSync(log) || !readFileSync(log, 'utf8').includes('pull')) {
      await Bun.sleep(5);
    }

    const startedAt = Date.now();

    client.abort();

    const outcomes = await ctx.readOutcomes('images.addStream', 1);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.outcome).not.toBe('ok');
    expect(Date.now() - startedAt).toBeLessThan(5000);
  } finally {
    process.env['PATH'] = savedPath;
  }
});

test('a client that goes from images.build or images.add stops its work, as a stream does', async () => {
  const started = { build: Promise.withResolvers<void>(), add: Promise.withResolvers<void>() };
  const stopped = { build: Promise.withResolvers<void>(), add: Promise.withResolvers<void>() };

  // work that runs until its signal aborts
  const runUntilAborted = async (kind: 'build' | 'add', signal: AbortSignal | undefined) => {
    started[kind].resolve();

    await new Promise((resolve) => {
      signal?.addEventListener('abort', resolve);
    });

    stopped[kind].resolve();
    throw new Error('stopped');
  };

  await using ctx = await setupTest({
    buildImage: (_contextDir, _name, _dockerfile, options) =>
      runUntilAborted('build', options?.signal),
    addImage: (_ref, _name, options) => runUntilAborted('add', options?.signal),
  });

  const builder = new AbortController();
  const adder = new AbortController();

  const building = waitForEnd(
    ctx.client.images.build({ contextDir: '/srv/ctx', name: 'web' }, { signal: builder.signal }),
  );

  const adding = waitForEnd(
    ctx.client.images.add({ ref: 'busybox:1.37', name: 'box' }, { signal: adder.signal }),
  );

  await Promise.all([started.build.promise, started.add.promise]);

  builder.abort();
  adder.abort();

  await Promise.all([stopped.build.promise, stopped.add.promise, building, adding]);
});
