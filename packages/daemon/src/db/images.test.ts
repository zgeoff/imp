import { expect, test } from 'bun:test';
import { createImage, findImageById, findImageByName, listImages, removeImage } from './images';
import { createImp } from './imps';
import { readRejectionMessage, setupTestDatabase } from './test-database';

test('it creates, finds and lists images by name', async () => {
  await using ctx = await setupTestDatabase();

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
  await using ctx = await setupTestDatabase();

  const duplicate = { name: 'base', ref: 'x', digest: 'sha256:2222', sizeBytes: 1 };

  const message = await readRejectionMessage(createImage(ctx.db, duplicate));

  expect(message).toContain('images.name');
});

test('it refuses to remove an image an imp still uses', async () => {
  await using ctx = await setupTestDatabase();

  await createImp(ctx.db, {
    name: 'dev',
    imageId: ctx.image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 0,
    ip: '10.66.0.2',
  });

  const message = await readRejectionMessage(removeImage(ctx.db, ctx.image.id));

  expect(message).toContain('FOREIGN KEY');
});

test('it removes an unused image once', async () => {
  await using ctx = await setupTestDatabase();

  const first = await removeImage(ctx.db, ctx.image.id);
  const second = await removeImage(ctx.db, ctx.image.id);

  expect(first).toBe(true);
  expect(second).toBe(false);
});
