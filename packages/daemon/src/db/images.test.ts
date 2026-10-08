import { expect, test } from 'bun:test';
import { createTestDatabase } from '../test-utils/create-test-database';
import { createImage, findImageById, findImageByName, listImages, removeImage } from './images';
import { createImp } from './imps';

test('it creates, finds and lists images by name', async () => {
  const ctx = await createTestDatabase();

  await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const dev = await createImage(ctx.db, {
    name: 'dev',
    ref: 'imp/hello:latest',
    digest: 'sha256:1111',
    sizeBytes: 2048,
  });

  const byName = await findImageByName(ctx.db, 'dev');
  const byId = await findImageById(ctx.db, dev.id);
  const images = await listImages(ctx.db);

  expect(byName).toEqual(dev);
  expect(byId).toEqual(dev);
  expect(images.map((image) => image.name)).toEqual(['base', 'dev']);
});

test('it rejects a duplicate image name', async () => {
  const ctx = await createTestDatabase();

  await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const duplicate = { name: 'base', ref: 'x', digest: 'sha256:2222', sizeBytes: 1 };

  expect(createImage(ctx.db, duplicate)).rejects.toThrowWithMessage(
    Error,
    /UNIQUE constraint failed: images\.name/u,
  );
});

test('it refuses to remove an image an imp still uses', async () => {
  const ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  await createImp(ctx.db, {
    name: 'dev',
    imageId: image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 0,
    ip: '10.66.0.2',
  });

  expect(removeImage(ctx.db, image.id)).rejects.toThrowWithMessage(
    Error,
    /FOREIGN KEY constraint failed/u,
  );
});

test('it removes an unused image once', async () => {
  const ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const first = await removeImage(ctx.db, image.id);
  const second = await removeImage(ctx.db, image.id);

  expect(first).toBe(true);
  expect(second).toBe(false);
});
