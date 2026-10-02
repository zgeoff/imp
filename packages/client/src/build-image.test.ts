import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createImage } from '@imp/daemon/src/db/images';
import type { ImageService } from '@imp/daemon/src/images/image-service';
import { TEST_TOKEN, buildTestApp, setupImpTest } from '@imp/daemon/src/imps/test-imps';
import { ORPCError } from '@orpc/client';
import { createImpClient } from './create-imp-client';

// impd in-process, its build a fake that records the tar it was handed
async function setupBuildTest(token = TEST_TOKEN) {
  const harness = await setupImpTest({ env: { IMP_BUILD_CONTEXT_MAX_MIB: '1' } });

  const received: string[] = [];

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

      url.pathname = url.pathname.replace(/^\/prefix/u, '');

      return app.handle(new Request(url.href, request));
    },
  });

  return {
    client,
    received,
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
