import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGE_BUILD_PATH, ImageBuildResultSchema } from '@imp/api';
import type { Scope } from '@imp/api';
import { createApiAudit } from '../audit/api-audit';
import { listApiCalls } from '../db/api-audit';
import { createImage } from '../db/images';
import { TEST_TOKEN, buildTestApp, setupImpTest } from '../imps/test-imps';
import { buildUploadsDir } from '../storage/data-layout';
import { createBuildContextRoute } from './build-context-route';
import type { ImageService } from './image-service';

interface BuildCall {
  readonly bytes: string;
  readonly name: string;
  readonly dockerfile: string | undefined;
}

interface TestOptions {
  readonly env?: Readonly<Record<string, string>>;

  // holds every build until it resolves
  readonly gate?: Promise<void>;

  // replaces the fake build
  readonly build?: ImageService['buildImageFromContext'];
}

// impd with a fake build that records what reached it
async function setupTest(options: TestOptions = {}) {
  const harness = await setupImpTest({ env: { ...options.env } });

  const calls: BuildCall[] = [];

  // builds stopped because their client went
  const stopped: string[] = [];

  const writeBuildCall: ImageService['buildImageFromContext'] = async (
    tarPath,
    name,
    dockerfile,
    signal,
  ) => {
    calls.push({ bytes: readFileSync(tarPath, 'utf8'), name, dockerfile });

    const gone = Promise.withResolvers<void>();

    signal.addEventListener('abort', () => {
      stopped.push(name);
      gone.resolve();
    });

    await Promise.race([options.gate, gone.promise]);

    signal.throwIfAborted();

    return createImage(harness.db, {
      name,
      ref: `imp/${name}:latest`,
      digest: 'sha256:x',
      sizeBytes: 1,
    });
  };

  const images = { ...harness.images, buildImageFromContext: options.build ?? writeBuildCall };
  const root = buildTestApp({ ...harness, images }, harness);

  const sendBuild = (
    query: string,
    body: string | ReadableStream<Uint8Array>,
    token = TEST_TOKEN,
    headers: Readonly<Record<string, string>> = {},
    signal: AbortSignal | null = null,
  ): Promise<Response> =>
    root.app.handle(
      new Request(`http://impd.test${IMAGE_BUILD_PATH}?${query}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, ...headers },
        body,
        signal,
      }),
    );

  const readStatus = async (
    query: string,
    body: string | ReadableStream<Uint8Array>,
    token = TEST_TOKEN,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<number> => {
    const response = await sendBuild(query, body, token, headers);

    return response.status;
  };

  const createToken = async (scope: Scope, imps: readonly string[] | null = null) => {
    const made = await root.client.tokens.create({
      name: `t-${scope}-${String(imps?.length ?? 0)}`,
      scope,
      ...(imps !== null && { imps: [...imps] }),
    });

    return made.secret;
  };

  // the outcome of every images.build audit row, oldest first
  const readOutcomes = async (count: number): Promise<string[]> => {
    const deadline = Date.now() + 5000;

    for (;;) {
      const rows = await listApiCalls(harness.db, null, 100, null);

      const builds = rows.filter((row) => row.procedure === 'images.build');

      if (builds.length >= count || Date.now() > deadline) {
        return builds.map((row) => row.outcome).toReversed();
      }

      await Bun.sleep(5);
    }
  };

  return {
    harness,
    calls,
    stopped,
    sendBuild,
    readStatus,
    createToken,
    readOutcomes,
    listUploads: () => readdirSync(buildUploadsDir(harness.config.dataDir)),
    [Symbol.asyncDispose]: () => harness[Symbol.asyncDispose](),
  };
}

// a body with no Content-Length: the route can only count what arrives
function createByteStream(total: number): ReadableStream<Uint8Array> {
  const state = { sent: 0 };

  return new ReadableStream({
    pull: (controller) => {
      if (state.sent >= total) {
        controller.close();

        return;
      }

      const chunk = new Uint8Array(Math.min(64 * 1024, total - state.sent));

      state.sent += chunk.byteLength;

      controller.enqueue(chunk);
    },
  });
}

test('a streamed context builds, answers the image and leaves no file behind', async () => {
  await using ctx = await setupTest();

  const response = await ctx.sendBuild('name=web&dockerfile=docker/Dockerfile', 'tar bytes');
  const body: unknown = await response.json();

  expect(response.status).toBe(200);
  expect(ImageBuildResultSchema.parse(body).name).toBe('web');
  expect(ctx.calls).toEqual([{ bytes: 'tar bytes', name: 'web', dockerfile: 'docker/Dockerfile' }]);
  expect(ctx.listUploads()).toEqual([]);

  const outcomes = await ctx.readOutcomes(1);

  expect(outcomes).toEqual(['ok']);
});

test('only a manage caller for the whole host may build', async () => {
  await using ctx = await setupTest();

  const limited = await ctx.createToken('manage', ['dev-*']);
  const reader = await ctx.createToken('read');
  const limitedStatus = await ctx.readStatus('name=web', 'tar', limited);
  const readerStatus = await ctx.readStatus('name=web', 'tar', reader);
  const strangerStatus = await ctx.readStatus('name=web', 'tar', 'not-a-token');

  expect([limitedStatus, readerStatus, strangerStatus]).toEqual([403, 403, 401]);
  expect(ctx.calls).toEqual([]);

  const outcomes = await ctx.readOutcomes(2);

  expect(outcomes).toEqual(['FORBIDDEN', 'FORBIDDEN']);
});

test('a bad name or a Dockerfile outside the context is refused before the upload', async () => {
  await using ctx = await setupTest();

  const queries = [
    'name=Bad Name',
    'name=web&dockerfile=../Dockerfile',
    'name=web&dockerfile=sub/../../Dockerfile',
    'name=web&dockerfile=/etc/passwd',
    '',
  ];

  for (const query of queries) {
    const status = await ctx.readStatus(query, 'tar');

    expect(status).toBe(400);
  }

  expect(ctx.calls).toEqual([]);
});

test('a context over the limit gets 413, by its Content-Length or by the bytes that come', async () => {
  await using ctx = await setupTest({ env: { IMP_BUILD_CONTEXT_MAX_MIB: '1' } });

  const declared = await ctx.readStatus('name=web', 'x', TEST_TOKEN, {
    'content-length': String(2 * 1024 ** 2),
  });

  expect(declared).toBe(413);

  // a refused Content-Length frees its build slot
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const again = await ctx.readStatus('name=web', 'x', TEST_TOKEN, {
      'content-length': String(2 * 1024 ** 2),
    });

    expect(again).toBe(413);
  }

  const streamed = await ctx.sendBuild('name=web', createByteStream(1024 ** 2 + 1));
  const body: unknown = await streamed.json();

  expect(streamed.status).toBe(413);
  expect(body).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  expect(ctx.listUploads()).toEqual([]);

  // exactly the limit is fine
  const atLimit = await ctx.readStatus('name=web', createByteStream(1024 ** 2));

  expect(atLimit).toBe(200);
  expect(ctx.calls).toHaveLength(1);
});

test('a fifth build while four upload or run gets 429', async () => {
  const gate = Promise.withResolvers<void>();

  await using ctx = await setupTest({ gate: gate.promise });

  const running = [1, 2, 3, 4].map((n) => ctx.readStatus(`name=web${String(n)}`, 'tar'));

  while (ctx.calls.length < 4) {
    await Bun.sleep(1);
  }

  const fifth = await ctx.readStatus('name=web5', 'tar');

  expect(fifth).toBe(429);

  gate.resolve();

  const statuses = await Promise.all(running);

  expect(statuses).toEqual([200, 200, 200, 200]);

  const sixth = await ctx.readStatus('name=web6', 'tar');

  expect(sixth).toBe(200);
});

test('a client that goes mid-build stops the build, frees its slot and its file', async () => {
  const gate = Promise.withResolvers<void>();

  await using ctx = await setupTest({ gate: gate.promise });

  const clients = [1, 2, 3, 4].map(() => new AbortController());

  const builds = clients.map((client, n) =>
    ctx.sendBuild(`name=gone${String(n)}`, 'tar', TEST_TOKEN, {}, client.signal),
  );

  while (ctx.calls.length < 4) {
    await Bun.sleep(1);
  }

  for (const client of clients) {
    client.abort();
  }

  await Promise.allSettled(builds);

  expect(ctx.stopped.toSorted()).toEqual(['gone0', 'gone1', 'gone2', 'gone3']);
  expect(ctx.listUploads()).toEqual([]);

  gate.resolve();

  const next = await ctx.readStatus('name=web', 'tar');

  expect(next).toBe(200);
});

test('a failed build answers its error and removes the upload', async () => {
  await using ctx = await setupTest({
    build: () => Promise.reject(new Error('disk on fire')),
  });

  const response = await ctx.sendBuild('name=web', 'tar');
  const body: unknown = await response.json();

  expect(response.status).toBe(500);
  expect(body).toEqual({ code: 'INTERNAL_SERVER_ERROR', message: 'disk on fire' });
  expect(ctx.listUploads()).toEqual([]);
});

test('a new route clears what an earlier impd left in the uploads directory', async () => {
  await using harness = await setupImpTest();

  const uploadsDir = buildUploadsDir(harness.config.dataDir);
  const leftover = join(uploadsDir, 'old.tar');

  mkdirSync(uploadsDir, { recursive: true });
  writeFileSync(leftover, 'half a context');

  createBuildContextRoute({
    config: harness.config,
    images: harness.images,
    diskBudget: harness.diskBudget,
    audit: createApiAudit({ db: harness.db, now: harness.now, log: () => {} }),
    now: harness.now,
  });

  expect(existsSync(leftover)).toBe(false);
});
