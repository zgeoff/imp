import { expect, test } from 'bun:test';
import { createTestDatabase } from '../test-utils/create-test-database';
import { createImage } from './images';
import { subscribeImpWrites } from './imp-write-feed';
import {
  JAIL_UIDS,
  allocateSlot,
  createImp,
  createImpInFreeSlot,
  findImpById,
  findImpByName,
  listImps,
  removeImp,
  updateImpActivity,
  updateImpDisk,
  updateImpState,
  updateImpStateIf,
} from './imps';
import type { ImpRecord, NewImp } from './imps';
import type { ImpDatabase } from './open-database';

function buildNewImp(imageId: string, name: string, slot: number): NewImp {
  return { name, imageId, vcpus: 2, memoryMib: 2048, slot, ip: `10.66.0.${String(slot * 4 + 2)}` };
}

function createWithSlot(db: ImpDatabase, imageId: string, name: string): Promise<ImpRecord> {
  return db.transaction().execute(async (trx) => {
    const slot = await allocateSlot(trx, 16);

    return createImp(trx, buildNewImp(imageId, name, slot));
  });
}

test('it creates an imp in the creating state and finds it by name and id', async () => {
  await using ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const imp = await createImp(ctx.db, buildNewImp(image.id, 'dev', 0));

  expect(imp).toMatchObject({ name: 'dev', state: 'creating', slot: 0, sleptAt: null, pid: null });
  expect(imp.createdAt).toBeInstanceOf(Date);

  const byName = await findImpByName(ctx.db, 'dev');
  const byId = await findImpById(ctx.db, imp.id);
  const missing = await findImpByName(ctx.db, 'nope');

  expect(byName).toEqual(imp);
  expect(byId).toEqual(imp);
  expect(missing).toBeUndefined();
});

test('a create in a free slot emits one ImpAdded, once it commits', async () => {
  await using ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const writes: string[] = [];

  subscribeImpWrites(ctx.db, (write) => {
    writes.push(`${write.kind} ${write.kind === 'added' ? write.imp.name : ''}`);
  });

  await createImpInFreeSlot(
    ctx.db,
    { name: 'dev', imageId: image.id, vcpus: 2, memoryMib: 2048 },
    { count: 16, findIp: (slot) => `10.66.0.${String(slot * 4 + 2)}` },
  );

  expect(writes).toEqual(['added dev']);
});

test('it allocates the lowest free slot, reusing a gap', async () => {
  await using ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const a = await createWithSlot(ctx.db, image.id, 'a');
  const b = await createWithSlot(ctx.db, image.id, 'b');
  const c = await createWithSlot(ctx.db, image.id, 'c');

  expect([a.slot, b.slot, c.slot]).toEqual([0, 1, 2]);

  await removeImp(ctx.db, b.id);

  const d = await createWithSlot(ctx.db, image.id, 'd');

  expect(d.slot).toBe(1);
});

test('it gives concurrent creates distinct slots', async () => {
  await using ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const imps = await Promise.all(
    ['a', 'b', 'c', 'd'].map((name) => createWithSlot(ctx.db, image.id, name)),
  );

  expect(imps.map((imp) => imp.slot).toSorted((x, y) => x - y)).toEqual([0, 1, 2, 3]);
});

test('it throws when every slot is taken', async () => {
  await using ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  await createImp(ctx.db, buildNewImp(image.id, 'a', 0));
  await createImp(ctx.db, buildNewImp(image.id, 'b', 1));

  expect(allocateSlot(ctx.db, 2)).rejects.toThrowWithMessage(
    Error,
    'every one of the 2 slots is taken',
  );
});

test('each imp gets its own jail uid, the lowest free one', async () => {
  await using ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const a = await createImp(ctx.db, buildNewImp(image.id, 'a', 0));
  const b = await createImp(ctx.db, buildNewImp(image.id, 'b', 1));

  expect([a.jailUid, b.jailUid]).toEqual([JAIL_UIDS.first, JAIL_UIDS.first + 1]);

  await removeImp(ctx.db, a.id);

  const c = await createImp(ctx.db, buildNewImp(image.id, 'c', 2));
  const found = await findImpById(ctx.db, c.id);

  expect(c.jailUid).toBe(JAIL_UIDS.first);
  expect(found?.jailUid).toBe(JAIL_UIDS.first);
});

test('a live ticket keeps its slot from a new imp until the commit', async () => {
  await using ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const slots = { count: 4, findIp: (slot: number) => `10.66.0.${String(slot * 4 + 2)}` };
  const imp = { imageId: image.id, vcpus: 2, memoryMib: 2048 };

  await ctx.db
    .insertInto('move_tickets')
    .values({
      id: 'ticket',
      secret_sha256: 'sha',
      name: 'moved',
      bytes: 1,
      imp_id: null,
      issued_at: 0,
      stream_by: Date.now() + 60_000,
      stream_used_at: null,
      receipt: null,
      commit_until: null,
      committed_at: null,
      slot: 0,
    })
    .execute();

  const other = await createImpInFreeSlot(ctx.db, { ...imp, name: 'new' }, slots);

  // a ticket whose stream never started holds the slot only until its window ends
  const late = await allocateSlot(ctx.db, 4, Date.now() + 120_000);
  const moved = await createImpInFreeSlot(ctx.db, { ...imp, name: 'moved' }, { ...slots, slot: 0 });

  expect(other.slot).toBe(1);
  expect(late).toBe(0);
  expect(moved.slot).toBe(0);

  expect(
    createImpInFreeSlot(ctx.db, { ...imp, name: 'again' }, { ...slots, slot: 1 }),
  ).rejects.toThrowWithMessage(Error, 'slot 1 is taken on this host');

  expect(
    createImpInFreeSlot(ctx.db, { ...imp, name: 'far' }, { ...slots, slot: 4 }),
  ).rejects.toThrowWithMessage(Error, 'slot 4 is taken on this host');
});

test('it rejects a duplicate name', async () => {
  await using ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  await createImp(ctx.db, buildNewImp(image.id, 'dev', 0));

  expect(createImp(ctx.db, buildNewImp(image.id, 'dev', 1))).rejects.toThrowWithMessage(
    Error,
    /UNIQUE constraint failed: imps\.name/u,
  );
});

test('it rejects a duplicate slot', async () => {
  await using ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  await createImp(ctx.db, buildNewImp(image.id, 'dev', 0));

  const duplicate = { ...buildNewImp(image.id, 'other', 0), ip: '10.66.9.9' };

  expect(createImp(ctx.db, duplicate)).rejects.toThrowWithMessage(
    Error,
    /UNIQUE constraint failed: imps\.slot/u,
  );
});

test('it rejects an imp whose image does not exist', async () => {
  await using ctx = await createTestDatabase();

  expect(createImp(ctx.db, buildNewImp('missing', 'dev', 0))).rejects.toThrowWithMessage(
    Error,
    /FOREIGN KEY constraint failed/u,
  );
});

test('it updates the state and only the fields the change names', async () => {
  await using ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const imp = await createImp(ctx.db, buildNewImp(image.id, 'dev', 0));

  const running = await updateImpState(ctx.db, imp.id, {
    reason: 'booted',
    state: 'running',
    pid: 4242,
    firecrackerVersion: 'v1.17.0',
  });

  expect(running).toMatchObject({ state: 'running', pid: 4242, firecrackerVersion: 'v1.17.0' });

  const sleptAt = new Date('2026-10-02T00:00:00Z');

  const sleeping = await updateImpState(ctx.db, imp.id, {
    reason: 'slept',
    state: 'sleeping',
    pid: null,
    sleptAt,
  });

  expect(sleeping).toMatchObject({
    state: 'sleeping',
    pid: null,
    sleptAt,
    firecrackerVersion: 'v1.17.0',
  });

  const failed = await updateImpState(ctx.db, imp.id, {
    reason: 'failed',
    state: 'error',
    error: 'boot timed out',
  });

  expect(failed).toMatchObject({ state: 'error', error: 'boot timed out', sleptAt });
});

test('it records activity', async () => {
  await using ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const imp = await createImp(ctx.db, buildNewImp(image.id, 'dev', 0));

  const at = new Date('2026-10-02T01:00:00Z');

  await updateImpActivity(ctx.db, imp.id, at);

  const active = await findImpById(ctx.db, imp.id);

  expect(active?.lastActiveAt).toEqual(at);
});

test('it lists imps by name', async () => {
  await using ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const b = await createImp(ctx.db, buildNewImp(image.id, 'b', 0));

  await createImp(ctx.db, buildNewImp(image.id, 'a', 1));
  await updateImpState(ctx.db, b.id, { reason: 'booted', state: 'running' });

  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => [imp.name, imp.state])).toEqual([
    ['a', 'creating'],
    ['b', 'running'],
  ]);
});

test('it applies a compare-and-set change only while the row matches', async () => {
  await using ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const imp = await createImp(ctx.db, buildNewImp(image.id, 'dev', 0));

  await updateImpState(ctx.db, imp.id, { reason: 'booted', state: 'running', pid: 42 });

  const stale = await updateImpStateIf(
    ctx.db,
    imp.id,
    { state: 'running', pid: 41 },
    { reason: 'stopped', state: 'stopped', pid: null },
  );

  const fresh = await updateImpStateIf(
    ctx.db,
    imp.id,
    { state: 'running', pid: 42 },
    { reason: 'stopped', state: 'stopped', pid: null },
  );

  expect(stale).toBeUndefined();
  expect(fresh).toMatchObject({ state: 'stopped', pid: null });
});

test('a new disk size emits ImpChanged resized; a pending grow alone does not', async () => {
  await using ctx = await createTestDatabase();

  // the image every imp row here refers to
  const image = await createImage(ctx.db, {
    name: 'base',
    ref: 'imp/base:latest',
    digest: 'sha256:0000',
    sizeBytes: 1024,
  });

  const imp = await createWithSlot(ctx.db, image.id, 'dev');

  const reasons: string[] = [];

  subscribeImpWrites(ctx.db, (write) => {
    const reason = write.kind === 'changed' ? write.reason : write.kind;

    reasons.push(reason);
  });

  await updateImpDisk(ctx.db, imp.id, { diskBytes: imp.diskBytes, isGrowPending: true });
  await updateImpDisk(ctx.db, imp.id, { diskBytes: 2 * imp.diskBytes, isGrowPending: true });

  expect(reasons).toEqual(['resized']);
});
