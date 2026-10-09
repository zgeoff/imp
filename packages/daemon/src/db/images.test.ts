import { expect, test } from 'bun:test';
import { buildMockNewImage } from '../test-utils/build-mock-new-image';
import { buildMockNewImp } from '../test-utils/build-mock-new-imp';
import { createTestDatabase } from '../test-utils/create-test-database';
import {
  countImageDigestUses,
  createImage,
  findImageByDigest,
  findImageById,
  findImageByName,
  listImages,
  removeImage,
  updateImage,
} from './images';
import { createImp } from './imps';

test('#createImage returns the stored image, a docker image by default', async () => {
  const ctx = await createTestDatabase();

  const image = await createImage(ctx.db, {
    name: 'dev',
    ref: 'imp/hello:latest',
    digest: 'sha256:1111',
    sizeBytes: 2048,
  });

  expect(image).toStrictEqual({
    id: expect.toBeString(),
    name: 'dev',
    ref: 'imp/hello:latest',
    digest: 'sha256:1111',
    source: 'oci',
    sourceImp: null,
    sizeBytes: 2048,
    createdAt: expect.toBeValidDate(),
  });
});

test('#createImage keeps the source imp of a template', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage({ source: 'imp', sourceImp: 'dev' }));

  expect(image).toMatchObject({ source: 'imp', sourceImp: 'dev' });
});

test('#createImage rejects a duplicate image name', async () => {
  const ctx = await createTestDatabase();

  await createImage(ctx.db, buildMockNewImage({ name: 'base' }));

  expect(createImage(ctx.db, buildMockNewImage({ name: 'base' }))).rejects.toThrowWithMessage(
    Error,
    /UNIQUE constraint failed: images\.name/u,
  );
});

test('#findImageByName finds the image of that name', async () => {
  const ctx = await createTestDatabase();

  await createImage(ctx.db, buildMockNewImage({ name: 'base' }));

  const dev = await createImage(ctx.db, buildMockNewImage({ name: 'dev' }));
  const found = await findImageByName(ctx.db, 'dev');

  expect(found).toStrictEqual(dev);
});

test('#findImageByName finds nothing for a name no image has', async () => {
  const ctx = await createTestDatabase();

  await createImage(ctx.db, buildMockNewImage({ name: 'base' }));

  const found = await findImageByName(ctx.db, 'dev');

  expect(found).toBeUndefined();
});

test('#findImageById finds the image of that id', async () => {
  const ctx = await createTestDatabase();
  const dev = await createImage(ctx.db, buildMockNewImage());
  const found = await findImageById(ctx.db, dev.id);

  expect(found).toStrictEqual(dev);
});

test('#findImageByDigest finds the oldest image of that digest', async () => {
  const ctx = await createTestDatabase();

  await ctx.db
    .insertInto('images')
    .values([
      { id: 'b', name: 'newer', ref: 'r', digest: 'sha256:1111', size_bytes: 1, created_at: 20 },
      { id: 'c', name: 'older', ref: 'r', digest: 'sha256:1111', size_bytes: 1, created_at: 10 },
      { id: 'a', name: 'other', ref: 'r', digest: 'sha256:2222', size_bytes: 1, created_at: 0 },
    ])
    .execute();

  const found = await findImageByDigest(ctx.db, 'sha256:1111');

  expect(found?.name).toBe('older');
});

test('#findImageByDigest breaks a tie in age by id', async () => {
  const ctx = await createTestDatabase();

  await ctx.db
    .insertInto('images')
    .values([
      { id: 'b', name: 'second', ref: 'r', digest: 'sha256:1111', size_bytes: 1, created_at: 10 },
      { id: 'a', name: 'first', ref: 'r', digest: 'sha256:1111', size_bytes: 1, created_at: 10 },
    ])
    .execute();

  const found = await findImageByDigest(ctx.db, 'sha256:1111');

  expect(found?.name).toBe('first');
});

test('#findImageByDigest finds nothing for a digest no image has', async () => {
  const ctx = await createTestDatabase();

  await createImage(ctx.db, buildMockNewImage({ digest: 'sha256:1111' }));

  const found = await findImageByDigest(ctx.db, 'sha256:2222');

  expect(found).toBeUndefined();
});

test('#listImages lists every image by name', async () => {
  const ctx = await createTestDatabase();

  await createImage(ctx.db, buildMockNewImage({ name: 'dev' }));
  await createImage(ctx.db, buildMockNewImage({ name: 'base' }));

  const images = await listImages(ctx.db);

  expect(images.map((image) => image.name)).toStrictEqual(['base', 'dev']);
});

test('#updateImage points the image at the new build and keeps its name', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage({ name: 'base', source: 'imp' }));

  const updated = await updateImage(ctx.db, image.id, {
    ref: 'imp/base:v2',
    digest: 'sha256:2222',
    sizeBytes: 4096,
    sourceImp: 'dev',
  });

  expect(updated).toStrictEqual({
    id: image.id,
    name: 'base',
    ref: 'imp/base:v2',
    digest: 'sha256:2222',
    source: 'imp',
    sourceImp: 'dev',
    sizeBytes: 4096,
    createdAt: image.createdAt,
  });
});

test('#updateImage clears the source imp when the build names none', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage({ sourceImp: 'dev' }));

  const updated = await updateImage(ctx.db, image.id, {
    ref: 'imp/base:v2',
    digest: 'sha256:2222',
    sizeBytes: 4096,
  });

  expect(updated.sourceImp).toBeNull();
});

test('#countImageDigestUses counts the images of that digest', async () => {
  const ctx = await createTestDatabase();

  await createImage(ctx.db, buildMockNewImage({ digest: 'sha256:1111' }));
  await createImage(ctx.db, buildMockNewImage({ digest: 'sha256:1111' }));
  await createImage(ctx.db, buildMockNewImage({ digest: 'sha256:2222' }));

  const uses = await countImageDigestUses(ctx.db, 'sha256:1111');

  expect(uses).toBe(2);
});

test('#removeImage refuses to remove an image an imp still uses', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  expect(removeImage(ctx.db, image.id)).rejects.toThrowWithMessage(
    Error,
    /FOREIGN KEY constraint failed/u,
  );
});

test('#removeImage reports an unused image as removed', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const isRemoved = await removeImage(ctx.db, image.id);

  expect(isRemoved).toBeTrue();
});

test('#removeImage reports an image that is gone already as not removed', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await removeImage(ctx.db, image.id);

  const isRemoved = await removeImage(ctx.db, image.id);

  expect(isRemoved).toBeFalse();
});
