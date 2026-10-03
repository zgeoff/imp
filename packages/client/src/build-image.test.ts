import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { IMAGE_BUILD_STREAM_TYPE } from '@imp/api';
import type { ImageBuildProgress } from '@imp/api';
import { createImage } from '@imp/daemon/src/db/images';
import type { ImageService } from '@imp/daemon/src/images/image-service';
import { TEST_TOKEN, buildTestApp, setupImpTest } from '@imp/daemon/src/imps/test-imps';
import { ORPCError } from '@orpc/client';
import { createImpClient } from './create-imp-client';
import { createIdleFetch, startSlowImpd } from './test-slow-impd';
import type { SlowImpdHarness } from './test-slow-impd';

// impd in-process, its build a fake that records the tar it was handed
async function setupBuildTest(token = TEST_TOKEN) {
  const harness = await setupImpTest({ env: { IMP_BUILD_CONTEXT_MAX_MIB: '1' } });

  const received: string[] = [];

  // the Content-Length of every upload
  const lengths: (string | null)[] = [];

  const buildImageFromContext: ImageService['buildImageFromContext'] = (tarPath, name) => {
    received.push(readFileSync(tarPath, 'utf8'));

    return createImage(harness.db, {
      name,
      ref: `imp/${name}:latest`,
      digest: 'sha256:x',
      sizeBytes: 1,
    });
  };

  const app = buildTestApp(
    { ...harness, images: { ...harness.images, buildImageFromContext } },
    harness,
  ).app;

  const client = createImpClient({
    url: 'http://impd.test/prefix/',
    token,
    fetch: (request) => {
      const url = new URL(request.url);

      lengths.push(request.headers.get('content-length'));

      url.pathname = url.pathname.replace(/^\/prefix/u, '');

      return app.handle(new Request(url.href, request));
    },
  });

  return {
    client,
    received,
    lengths,
    [Symbol.asyncDispose]: () => harness[Symbol.asyncDispose](),
  };
}

test('buildImage uploads a Blob, bytes or a stream and answers the image', async () => {
  await using ctx = await setupBuildTest();

  const stream = new Blob(['as a stream']).stream();

  const images = [
    await ctx.client.buildImage('one', new Blob(['as a blob'])),
    await ctx.client.buildImage('two', new TextEncoder().encode('as bytes')),
    await ctx.client.buildImage('three', stream, { dockerfile: 'sub/Dockerfile' }),
  ];

  expect(images.map((image) => image.name)).toEqual(['one', 'two', 'three']);
  expect(images[0]?.createdAt).toBeInstanceOf(Date);
  expect(ctx.received).toEqual(['as a blob', 'as bytes', 'as a stream']);
});

test('buildImage throws the ORPCError impd answered', async () => {
  await using ctx = await setupBuildTest();

  const tooLarge = await ctx.client
    .buildImage('big', new Uint8Array(1024 ** 2 + 1))
    .catch((error: unknown) => error);

  expect(tooLarge).toBeInstanceOf(ORPCError);
  expect(tooLarge).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', status: 413 });

  const outside = await ctx.client
    .buildImage('web', new Blob(['tar']), { dockerfile: '../Dockerfile' })
    .catch((error: unknown) => error);

  expect(outside).toMatchObject({ code: 'BAD_REQUEST', status: 400 });
});

test('buildImage without a valid token is UNAUTHORIZED', async () => {
  await using ctx = await setupBuildTest('wrong');

  const failure = await ctx.client
    .buildImage('web', new Blob(['tar']))
    .catch((error: unknown) => error);

  expect(failure).toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
});

test('a stream with its size goes with that Content-Length', async () => {
  await using ctx = await setupBuildTest();

  const stream = new Blob(['as a stream']).stream();

  await ctx.client.buildImage('sized', stream, { size: 11 });

  expect(ctx.lengths).toEqual(['11']);
  expect(ctx.received).toEqual(['as a stream']);
});

// impd on a real listener, whose build takes `buildMs`
function startSlowBuild(harness: SlowImpdHarness, buildMs: number, keepaliveMs: number) {
  const buildImageFromContext: ImageService['buildImageFromContext'] = async (_, name) => {
    await Bun.sleep(buildMs);

    return createImage(harness.db, {
      name,
      ref: `imp/${name}:latest`,
      digest: 'sha256:x',
      sizeBytes: 1,
    });
  };

  return startSlowImpd(harness, { buildImageFromContext }, keepaliveMs);
}

// what an impd from before the stream sees: no Accept
function removeAccept(next: (request: Request) => Promise<Response>) {
  return (request: Request): Promise<Response> => {
    const headers = new Headers(request.headers);

    headers.delete('accept');

    return next(new Request(request, { headers }));
  };
}

test('a build longer than the fetch waits for a byte succeeds as a stream, and fails as JSON', async () => {
  await using harness = await setupImpTest();
  await using impd = startSlowBuild(harness, 500, 25);

  const idleFetch = createIdleFetch(200);
  const progress: ImageBuildProgress[] = [];
  const streamed = createImpClient({ url: impd.url, token: TEST_TOKEN, fetch: idleFetch });

  const image = await streamed.buildImage('slow', new Blob(['tar']), {
    onProgress: (event) => {
      progress.push(event);
    },
  });

  expect(image.name).toBe('slow');
  expect(progress[0]?.phase).toBe('upload');
  expect(progress.filter((event) => event.phase === 'build').length).toBeGreaterThan(2);

  // the answer at the end only, as before the stream
  const whole = createImpClient({
    url: impd.url,
    token: TEST_TOKEN,
    fetch: removeAccept(idleFetch),
  });

  const failure = await whole
    .buildImage('slow2', new Blob(['tar']))
    .catch((error: unknown) => error);

  expect(failure).toMatchObject({ name: 'TimeoutError' });
});

test('an impd that answers JSON, from before the stream, still builds', async () => {
  await using ctx = await setupBuildTest();

  const headers: (string | null)[] = [];

  const client = createImpClient({
    url: 'http://impd.test/',
    token: TEST_TOKEN,
    fetch: removeAccept(async (request) => {
      headers.push(request.headers.get('accept'));

      const answer = await ctx.client.buildImage('old', new Blob(['tar']));

      return Response.json(answer);
    }),
  });

  const image = await client.buildImage('old', new Blob(['tar']));

  expect(headers).toEqual([null]);
  expect(image.name).toBe('old');
  expect(image.createdAt).toBeInstanceOf(Date);
});

// a build whose answer is these lines, as a stream
function buildFromLines(lines: readonly unknown[]): Promise<unknown> {
  const client = createImpClient({
    url: 'http://impd.test/',
    token: TEST_TOKEN,
    fetch: () =>
      Promise.resolve(
        new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(''), {
          headers: { 'content-type': IMAGE_BUILD_STREAM_TYPE },
        }),
      ),
  });

  return client.buildImage('web', new Blob(['tar']));
}

test('a stream that ends in an error throws its ORPCError; one cut short throws too', async () => {
  const progress = { type: 'progress', phase: 'build', elapsedMs: 15_000 };

  const failed = await buildFromLines([
    progress,
    { type: 'from-a-newer-impd' },
    { type: 'error', code: 'BAD_REQUEST', message: 'the Dockerfile: no FROM' },
  ]).catch((error: unknown) => error);

  expect(failed).toBeInstanceOf(ORPCError);

  expect(failed).toMatchObject({
    code: 'BAD_REQUEST',
    status: 400,
    message: 'the Dockerfile: no FROM',
  });

  const cut = await buildFromLines([progress]).catch((error: unknown) => error);

  expect(cut).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
});
