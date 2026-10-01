import { expect, test } from 'bun:test';
import {
  allocateSlot,
  countImps,
  createImp,
  findImpById,
  findImpByName,
  listImps,
  removeImp,
  updateImpActivity,
  updateImpHold,
  updateImpState,
  updateImpStateIf,
} from './imps';
import type { ImpRecord, NewImp } from './imps';
import type { ImpDatabase } from './open-database';
import { readRejectionMessage, setupTestDatabase } from './test-database';

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
  await using ctx = await setupTestDatabase();

  const imp = await createImp(ctx.db, buildNewImp(ctx.image.id, 'dev', 0));

  expect(imp).toMatchObject({ name: 'dev', state: 'creating', slot: 0, sleptAt: null, pid: null });
  expect(imp.createdAt).toBeInstanceOf(Date);

  const byName = await findImpByName(ctx.db, 'dev');
  const byId = await findImpById(ctx.db, imp.id);
  const missing = await findImpByName(ctx.db, 'nope');

  expect(byName).toEqual(imp);
  expect(byId).toEqual(imp);
  expect(missing).toBeUndefined();
});

test('it allocates the lowest free slot, reusing a gap', async () => {
  await using ctx = await setupTestDatabase();

  const a = await createWithSlot(ctx.db, ctx.image.id, 'a');
  const b = await createWithSlot(ctx.db, ctx.image.id, 'b');
  const c = await createWithSlot(ctx.db, ctx.image.id, 'c');

  expect([a.slot, b.slot, c.slot]).toEqual([0, 1, 2]);

  await removeImp(ctx.db, b.id);

  const d = await createWithSlot(ctx.db, ctx.image.id, 'd');

  expect(d.slot).toBe(1);
});

test('it gives concurrent creates distinct slots', async () => {
  await using ctx = await setupTestDatabase();

  const imps = await Promise.all(
    ['a', 'b', 'c', 'd'].map((name) => createWithSlot(ctx.db, ctx.image.id, name)),
  );

  expect(imps.map((imp) => imp.slot).toSorted((x, y) => x - y)).toEqual([0, 1, 2, 3]);
});

test('it throws when every slot is taken', async () => {
  await using ctx = await setupTestDatabase();

  await createImp(ctx.db, buildNewImp(ctx.image.id, 'a', 0));
  await createImp(ctx.db, buildNewImp(ctx.image.id, 'b', 1));

  const message = await readRejectionMessage(allocateSlot(ctx.db, 2));

  expect(message).toBe('every one of the 2 slots is taken');
});

test('it rejects a duplicate name', async () => {
  await using ctx = await setupTestDatabase();

  await createImp(ctx.db, buildNewImp(ctx.image.id, 'dev', 0));

  const message = await readRejectionMessage(
    createImp(ctx.db, buildNewImp(ctx.image.id, 'dev', 1)),
  );

  expect(message).toContain('imps.name');
});

test('it rejects a duplicate slot', async () => {
  await using ctx = await setupTestDatabase();

  await createImp(ctx.db, buildNewImp(ctx.image.id, 'dev', 0));

  const duplicate = { ...buildNewImp(ctx.image.id, 'other', 0), ip: '10.66.9.9' };

  const message = await readRejectionMessage(createImp(ctx.db, duplicate));

  expect(message).toContain('imps.slot');
});

test('it rejects an imp whose image does not exist', async () => {
  await using ctx = await setupTestDatabase();

  const message = await readRejectionMessage(createImp(ctx.db, buildNewImp('missing', 'dev', 0)));

  expect(message).toContain('FOREIGN KEY');
});

test('it updates the state and only the fields the change names', async () => {
  await using ctx = await setupTestDatabase();

  const imp = await createImp(ctx.db, buildNewImp(ctx.image.id, 'dev', 0));

  const running = await updateImpState(ctx.db, imp.id, {
    state: 'running',
    pid: 4242,
    firecrackerVersion: 'v1.17.0',
  });

  expect(running).toMatchObject({ state: 'running', pid: 4242, firecrackerVersion: 'v1.17.0' });

  const sleptAt = new Date('2026-10-02T00:00:00Z');

  const sleeping = await updateImpState(ctx.db, imp.id, { state: 'sleeping', pid: null, sleptAt });

  expect(sleeping).toMatchObject({
    state: 'sleeping',
    pid: null,
    sleptAt,
    firecrackerVersion: 'v1.17.0',
  });

  const failed = await updateImpState(ctx.db, imp.id, { state: 'error', error: 'boot timed out' });

  expect(failed).toMatchObject({ state: 'error', error: 'boot timed out', sleptAt });
});

test('it records activity and holds', async () => {
  await using ctx = await setupTestDatabase();

  const imp = await createImp(ctx.db, buildNewImp(ctx.image.id, 'dev', 0));

  const at = new Date('2026-10-02T01:00:00Z');

  await updateImpActivity(ctx.db, imp.id, at);

  const active = await findImpById(ctx.db, imp.id);
  const held = await updateImpHold(ctx.db, imp.id, at);
  const released = await updateImpHold(ctx.db, imp.id, null);

  expect(active?.lastActiveAt).toEqual(at);
  expect(held.holdUntil).toEqual(at);
  expect(released.holdUntil).toBeNull();
});

test('it lists imps by name and counts them by state', async () => {
  await using ctx = await setupTestDatabase();

  const b = await createImp(ctx.db, buildNewImp(ctx.image.id, 'b', 0));

  await createImp(ctx.db, buildNewImp(ctx.image.id, 'a', 1));
  await updateImpState(ctx.db, b.id, { state: 'running' });

  const imps = await listImps(ctx.db);
  const total = await countImps(ctx.db);
  const running = await countImps(ctx.db, 'running');
  const sleeping = await countImps(ctx.db, 'sleeping');

  expect(imps.map((imp) => imp.name)).toEqual(['a', 'b']);
  expect(total).toBe(2);
  expect(running).toBe(1);
  expect(sleeping).toBe(0);
});

test('it applies a compare-and-set change only while the row matches', async () => {
  await using ctx = await setupTestDatabase();

  const imp = await createImp(ctx.db, buildNewImp(ctx.image.id, 'dev', 0));

  await updateImpState(ctx.db, imp.id, { state: 'running', pid: 42 });

  const stale = await updateImpStateIf(
    ctx.db,
    imp.id,
    { state: 'running', pid: 41 },
    { state: 'stopped', pid: null },
  );

  const fresh = await updateImpStateIf(
    ctx.db,
    imp.id,
    { state: 'running', pid: 42 },
    { state: 'stopped', pid: null },
  );

  expect(stale).toBeUndefined();
  expect(fresh).toMatchObject({ state: 'stopped', pid: null });
});
