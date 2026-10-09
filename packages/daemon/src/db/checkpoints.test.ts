import { expect, onTestFinished, test } from 'bun:test';
import { buildMockCheckpointRecord } from '../test-utils/build-mock-checkpoint-record';
import { buildMockNewImage } from '../test-utils/build-mock-new-image';
import { buildMockNewImp } from '../test-utils/build-mock-new-imp';
import { createTestDatabase } from '../test-utils/create-test-database';
import {
  createCheckpoint,
  findCheckpoint,
  listCheckpoints,
  removeCheckpoint,
  toApiCheckpoint,
} from './checkpoints';
import { createImage } from './images';
import { subscribeImpWrites } from './imp-write-feed';
import type { ImpWrite } from './imp-write-feed';
import { createImp, removeImp } from './imps';

test('#createCheckpoint returns the stored checkpoint, made now on a 32 GiB disk', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const before = new Date();

  const checkpoint = await createCheckpoint(ctx.db, {
    id: 'cp-1',
    impId: imp.id,
    label: 'clean',
    sizeBytes: 10,
  });

  expect(checkpoint).toStrictEqual({
    id: 'cp-1',
    impId: imp.id,
    label: 'clean',
    createdAt: expect.toBeBetween(before, new Date()),
    sizeBytes: 10,
    diskBytes: 32 * 1024 ** 3,
  });
});

test('#createCheckpoint keeps the time and disk size it is given', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const checkpoint = await createCheckpoint(ctx.db, {
    id: 'cp-1',
    impId: imp.id,
    label: null,
    sizeBytes: null,
    diskBytes: 1024 ** 3,
    createdAt: new Date(1_800_000_000_000),
  });

  expect(checkpoint).toStrictEqual({
    id: 'cp-1',
    impId: imp.id,
    label: null,
    createdAt: new Date(1_800_000_000_000),
    sizeBytes: null,
    diskBytes: 1024 ** 3,
  });
});

test('#createCheckpoint emits one checkpointAdded', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const writes: ImpWrite[] = [];

  const unsubscribe = subscribeImpWrites(ctx.db, (write) => {
    writes.push(write);
  });

  onTestFinished(unsubscribe);

  const checkpoint = await createCheckpoint(ctx.db, {
    id: 'cp-1',
    impId: imp.id,
    label: null,
    sizeBytes: null,
  });

  expect(writes).toStrictEqual([{ kind: 'checkpointAdded', checkpoint }]);
});

test('#createCheckpoint rejects a duplicate label on one imp', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await createCheckpoint(ctx.db, { id: 'cp-1', impId: imp.id, label: 'clean', sizeBytes: 1 });

  expect(
    createCheckpoint(ctx.db, { id: 'cp-2', impId: imp.id, label: 'clean', sizeBytes: 1 }),
  ).rejects.toThrowWithMessage(Error, /UNIQUE constraint failed/u);
});

test('#createCheckpoint rejects a checkpoint for an imp that does not exist', async () => {
  const ctx = await createTestDatabase();

  expect(
    createCheckpoint(ctx.db, { id: 'cp-x', impId: 'missing', label: null, sizeBytes: null }),
  ).rejects.toThrowWithMessage(Error, /FOREIGN KEY constraint failed/u);
});

test('#listCheckpoints lists newest first', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await createCheckpoint(ctx.db, {
    id: 'cp-b',
    impId: imp.id,
    label: null,
    sizeBytes: null,
    createdAt: new Date(1_800_000_000_000),
  });

  await createCheckpoint(ctx.db, {
    id: 'cp-a',
    impId: imp.id,
    label: null,
    sizeBytes: null,
    createdAt: new Date(1_800_000_060_000),
  });

  const checkpoints = await listCheckpoints(ctx.db, imp.id);

  expect(checkpoints.map((checkpoint) => checkpoint.id)).toStrictEqual(['cp-a', 'cp-b']);
});

test('#listCheckpoints puts the larger id first when two were made at once', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  for (const id of ['cp-1', 'cp-2']) {
    await createCheckpoint(ctx.db, {
      id,
      impId: imp.id,
      label: null,
      sizeBytes: null,
      createdAt: new Date(1_800_000_000_000),
    });
  }

  const checkpoints = await listCheckpoints(ctx.db, imp.id);

  expect(checkpoints.map((checkpoint) => checkpoint.id)).toStrictEqual(['cp-2', 'cp-1']);
});

test('#listCheckpoints leaves out another imp’s checkpoints', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const dev = await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 0 }));
  const other = await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 1 }));

  await createCheckpoint(ctx.db, { id: 'cp-1', impId: other.id, label: null, sizeBytes: null });

  const checkpoints = await listCheckpoints(ctx.db, dev.id);

  expect(checkpoints).toStrictEqual([]);
});

test('#findCheckpoint finds a checkpoint by id', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const checkpoint = await createCheckpoint(ctx.db, {
    id: 'cp-3',
    impId: imp.id,
    label: 'clean',
    sizeBytes: 1,
  });

  const found = await findCheckpoint(ctx.db, imp.id, 'cp-3');

  expect(found).toStrictEqual(checkpoint);
});

test('#findCheckpoint finds a checkpoint by label', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const checkpoint = await createCheckpoint(ctx.db, {
    id: 'cp-3',
    impId: imp.id,
    label: 'clean',
    sizeBytes: 1,
  });

  const found = await findCheckpoint(ctx.db, imp.id, 'clean');

  expect(found).toStrictEqual(checkpoint);
});

test('#findCheckpoint finds nothing for a label no checkpoint has', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await createCheckpoint(ctx.db, { id: 'cp-3', impId: imp.id, label: 'clean', sizeBytes: 1 });

  const found = await findCheckpoint(ctx.db, imp.id, 'dirty');

  expect(found).toBeUndefined();
});

test('#removeCheckpoint removes only that checkpoint', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await createCheckpoint(ctx.db, { id: 'cp-4', impId: imp.id, label: 'a', sizeBytes: 1 });
  await createCheckpoint(ctx.db, { id: 'cp-5', impId: imp.id, label: 'b', sizeBytes: 1 });

  const removed = await removeCheckpoint(ctx.db, 'cp-4');
  const remaining = await listCheckpoints(ctx.db, imp.id);

  expect(removed).toBeTrue();
  expect(remaining.map((checkpoint) => checkpoint.id)).toStrictEqual(['cp-5']);
});

test('#removeCheckpoint emits one checkpointRemoved', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const checkpoint = await createCheckpoint(ctx.db, {
    id: 'cp-4',
    impId: imp.id,
    label: null,
    sizeBytes: null,
  });

  const writes: ImpWrite[] = [];

  const unsubscribe = subscribeImpWrites(ctx.db, (write) => {
    writes.push(write);
  });

  onTestFinished(unsubscribe);

  await removeCheckpoint(ctx.db, checkpoint.id);

  expect(writes).toStrictEqual([{ kind: 'checkpointRemoved', checkpoint }]);
});

test('#removeCheckpoint reports a checkpoint that does not exist as not removed', async () => {
  const ctx = await createTestDatabase();
  const isRemoved = await removeCheckpoint(ctx.db, 'cp-missing');

  expect(isRemoved).toBeFalse();
});

test('#removeCheckpoint emits nothing for a checkpoint that does not exist', async () => {
  const ctx = await createTestDatabase();

  const writes: ImpWrite[] = [];

  const unsubscribe = subscribeImpWrites(ctx.db, (write) => {
    writes.push(write);
  });

  onTestFinished(unsubscribe);

  await removeCheckpoint(ctx.db, 'cp-missing');

  expect(writes).toStrictEqual([]);
});

test('#removeImp removes the imp’s checkpoints with it', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await createCheckpoint(ctx.db, { id: 'cp-5', impId: imp.id, label: 'b', sizeBytes: 1 });
  await removeImp(ctx.db, imp.id);

  const checkpoints = await listCheckpoints(ctx.db, imp.id);

  expect(checkpoints).toStrictEqual([]);
});

test('#toApiCheckpoint gives the label, the size and the disk in whole MiB', () => {
  const checkpoint = buildMockCheckpointRecord({
    id: 'cp-1',
    label: 'clean',
    createdAt: new Date(1_800_000_000_000),
    sizeBytes: 10,
    diskBytes: 1_048_577,
  });

  expect(toApiCheckpoint(checkpoint)).toStrictEqual({
    id: 'cp-1',
    createdAt: new Date(1_800_000_000_000),
    diskMib: 2,
    label: 'clean',
    sizeBytes: 10,
  });
});

test('#toApiCheckpoint leaves out a missing label and size', () => {
  const checkpoint = buildMockCheckpointRecord({
    id: 'cp-1',
    label: null,
    createdAt: new Date(1_800_000_000_000),
    sizeBytes: null,
    diskBytes: 1_048_576,
  });

  expect(toApiCheckpoint(checkpoint)).toStrictEqual({
    id: 'cp-1',
    createdAt: new Date(1_800_000_000_000),
    diskMib: 1,
  });
});
