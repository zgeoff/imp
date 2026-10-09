import { expect, onTestFinished, test } from 'bun:test';
import { buildMockLeaseRecord } from '../test-utils/build-mock-lease-record';
import { buildMockNewImage } from '../test-utils/build-mock-new-image';
import { buildMockNewImp } from '../test-utils/build-mock-new-imp';
import { createTestDatabase } from '../test-utils/create-test-database';
import { createUnmigratedDatabase } from '../test-utils/create-unmigrated-database';
import { createImage } from './images';
import { subscribeImpWrites } from './imp-write-feed';
import type { ImpWrite } from './imp-write-feed';
import { createImp, findImpById, removeImp } from './imps';
import { isBlockingLease, listLeases, removeLeases, writeLease, writeMovedLeases } from './leases';
import { runMigrations, runMigrationsTo } from './run-migrations';

test('#writeLease sets the hold to the lease’s end', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const held = await writeLease(
    ctx.db,
    buildMockLeaseRecord({ impId: imp.id, until: new Date(1_800_000_060_000) }),
    { at: 1_800_000_000_000, reason: 'held' },
  );

  expect(held.holdUntil).toStrictEqual(new Date(1_800_000_060_000));
});

test('#writeLease sets the hold to the latest end of the live leases', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({ impId: imp.id, until: new Date(1_800_000_120_000) }),
    { at: 1_800_000_000_000, reason: 'held' },
  );

  const held = await writeLease(
    ctx.db,
    buildMockLeaseRecord({ impId: imp.id, until: new Date(1_800_000_060_000) }),
    { at: 1_800_000_000_000, reason: 'held' },
  );

  expect(held.holdUntil).toStrictEqual(new Date(1_800_000_120_000));
});

test('#writeLease holds past every end for a lease with no end', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({ impId: imp.id, until: new Date(1_800_000_120_000) }),
    { at: 1_800_000_000_000, reason: 'held' },
  );

  const held = await writeLease(ctx.db, buildMockLeaseRecord({ impId: imp.id, until: null }), {
    at: 1_800_000_000_000,
    reason: null,
  });

  expect(held.holdUntil).toBeAfter(new Date(1_800_000_120_000));
});

test('#writeLease moves the end and keeps when the lease was made', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({
      impId: imp.id,
      principal: 'token:a',
      label: 'job',
      display: 'a',
      until: new Date(1_800_000_060_000),
      createdAt: new Date(1_800_000_000_000),
    }),
    { at: 1_800_000_000_000, reason: 'held' },
  );

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({
      impId: imp.id,
      principal: 'token:a',
      label: 'job',
      display: 'a2',
      until: new Date(1_800_000_090_000),
      createdAt: new Date(1_800_000_030_000),
    }),
    { at: 1_800_000_030_000, reason: null },
  );

  const leases = await listLeases(ctx.db, 1_800_000_030_000);

  expect(leases).toStrictEqual([
    {
      impId: imp.id,
      principal: 'token:a',
      label: 'job',
      display: 'a2',
      until: new Date(1_800_000_090_000),
      createdAt: new Date(1_800_000_000_000),
    },
  ]);
});

test('#writeLease emits nothing for a renew', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const writes: ImpWrite[] = [];

  const unsubscribe = subscribeImpWrites(ctx.db, (write) => {
    writes.push(write);
  });

  onTestFinished(unsubscribe);

  await writeLease(ctx.db, buildMockLeaseRecord({ impId: imp.id }), {
    at: 1_800_000_000_000,
    reason: null,
  });

  expect(writes).toStrictEqual([]);
});

test('#writeLease emits ImpChanged with its reason', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const writes: ImpWrite[] = [];

  const unsubscribe = subscribeImpWrites(ctx.db, (write) => {
    writes.push(write);
  });

  onTestFinished(unsubscribe);

  const held = await writeLease(ctx.db, buildMockLeaseRecord({ impId: imp.id }), {
    at: 1_800_000_000_000,
    reason: 'held',
  });

  expect(writes).toStrictEqual([{ kind: 'changed', imp: held, reason: 'held' }]);
});

test('#writeLease writes an ended lease anew, with a new start', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({
      impId: imp.id,
      principal: 'token:a',
      label: 'job',
      until: new Date(1_800_000_060_000),
      createdAt: new Date(1_800_000_000_000),
    }),
    { at: 1_800_000_000_000, reason: 'held' },
  );

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({
      impId: imp.id,
      principal: 'token:a',
      label: 'job',
      until: new Date(1_800_000_071_000),
      createdAt: new Date(1_800_000_061_000),
    }),
    { at: 1_800_000_061_000, reason: 'held' },
  );

  const leases = await listLeases(ctx.db, 1_800_000_061_000);

  expect(leases.map((lease) => lease.createdAt)).toStrictEqual([new Date(1_800_000_061_000)]);
});

test('#listLeases lists a lease until just before its end', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({ impId: imp.id, until: new Date(1_800_000_060_000) }),
    { at: 1_800_000_000_000, reason: 'held' },
  );

  const leases = await listLeases(ctx.db, 1_800_000_059_999);

  expect(leases).toHaveLength(1);
});

test('#listLeases leaves out a lease past its end', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({ impId: imp.id, until: new Date(1_800_000_060_000) }),
    { at: 1_800_000_000_000, reason: 'held' },
  );

  const leases = await listLeases(ctx.db, 1_800_000_060_000);

  expect(leases).toStrictEqual([]);
});

test('#listLeases lists only the leases of the imps it names', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const dev = await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 0 }));
  const other = await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 1 }));

  await writeLease(ctx.db, buildMockLeaseRecord({ impId: dev.id }), {
    at: 1_800_000_000_000,
    reason: null,
  });

  await writeLease(ctx.db, buildMockLeaseRecord({ impId: other.id }), {
    at: 1_800_000_000_000,
    reason: null,
  });

  const leases = await listLeases(ctx.db, 1_800_000_000_000, [dev.id]);

  expect(leases.map((lease) => lease.impId)).toStrictEqual([dev.id]);
});

test('#listLeases lists nothing for an empty set of imps', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeLease(ctx.db, buildMockLeaseRecord({ impId: imp.id }), {
    at: 1_800_000_000_000,
    reason: null,
  });

  const leases = await listLeases(ctx.db, 1_800_000_000_000, []);

  expect(leases).toStrictEqual([]);
});

test('#removeLeases sets the hold back to the latest remaining end', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({
      impId: imp.id,
      principal: 'token:b',
      until: new Date(1_800_000_120_000),
    }),
    { at: 1_800_000_000_000, reason: 'held' },
  );

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({ impId: imp.id, principal: 'token:c', label: 'job', until: null }),
    { at: 1_800_000_000_000, reason: null },
  );

  await removeLeases(ctx.db, imp.id, [{ principal: 'token:c', label: 'job' }], {
    at: 1_800_000_000_000,
    reason: 'held',
  });

  const stored = await findImpById(ctx.db, imp.id);

  expect(stored?.holdUntil).toStrictEqual(new Date(1_800_000_120_000));
});

test('#removeLeases removes only the named owner’s lease', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({ impId: imp.id, principal: 'token:a', label: 'job' }),
    { at: 1_800_000_000_000, reason: 'held' },
  );

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({ impId: imp.id, principal: 'token:b', label: 'job' }),
    { at: 1_800_000_000_000, reason: 'held' },
  );

  const removed = await removeLeases(ctx.db, imp.id, [{ principal: 'token:b', label: 'job' }], {
    at: 1_800_000_000_000,
    reason: 'held',
  });

  const left = await listLeases(ctx.db, 1_800_000_000_000);

  expect(removed.removed).toBe(1);
  expect(left.map((lease) => lease.principal)).toStrictEqual(['token:a']);
});

test('#removeLeases reports a removal that took nothing', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({ impId: imp.id, principal: 'token:a', label: 'job' }),
    { at: 1_800_000_000_000, reason: 'held' },
  );

  const removed = await removeLeases(ctx.db, imp.id, [{ principal: 'token:b', label: 'job' }], {
    at: 1_800_000_000_000,
    reason: 'held',
  });

  expect(removed.removed).toBe(0);
});

test('#removeLeases emits nothing for a removal that took nothing', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const writes: ImpWrite[] = [];

  const unsubscribe = subscribeImpWrites(ctx.db, (write) => {
    writes.push(write);
  });

  onTestFinished(unsubscribe);

  await removeLeases(ctx.db, imp.id, [{ principal: 'token:b', label: 'job' }], {
    at: 1_800_000_000_000,
    reason: 'held',
  });

  expect(writes).toStrictEqual([]);
});

test('#removeLeases emits for a removal that took nothing when told to', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const writes: ImpWrite[] = [];

  const unsubscribe = subscribeImpWrites(ctx.db, (write) => {
    writes.push(write);
  });

  onTestFinished(unsubscribe);

  const removed = await removeLeases(ctx.db, imp.id, [], {
    at: 1_800_000_000_000,
    reason: 'held',
    isEmittedWhenNone: true,
  });

  expect(writes).toStrictEqual([{ kind: 'changed', imp: removed.imp, reason: 'held' }]);
});

test('#removeLeases takes only the leases made through leases.* on a forced clear', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  for (const lease of [
    buildMockLeaseRecord({ impId: imp.id, principal: 'token:a', label: 'job' }),
    buildMockLeaseRecord({ impId: imp.id, principal: 'token:a', label: 'other' }),
    buildMockLeaseRecord({ impId: imp.id, principal: 'token:a', label: 'hold' }),
    buildMockLeaseRecord({ impId: imp.id, principal: 'legacy', label: 'hold' }),
  ]) {
    await writeLease(ctx.db, lease, { at: 1_800_000_000_000, reason: null });
  }

  const cleared = await removeLeases(ctx.db, imp.id, 'blocking', {
    at: 1_800_000_000_000,
    reason: 'released',
  });

  const left = await listLeases(ctx.db, 1_800_000_000_000);

  expect(cleared.removed).toBe(2);

  expect(left.map((lease) => `${lease.principal}/${lease.label}`)).toIncludeSameMembers([
    'legacy/hold',
    'token:a/hold',
  ]);
});

test('#removeLeases emits how many leases a forced clear released', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({ impId: imp.id, principal: 'token:a', label: 'job' }),
    { at: 1_800_000_000_000, reason: null },
  );

  const writes: ImpWrite[] = [];

  const unsubscribe = subscribeImpWrites(ctx.db, (write) => {
    writes.push(write);
  });

  onTestFinished(unsubscribe);

  const cleared = await removeLeases(ctx.db, imp.id, 'blocking', {
    at: 1_800_000_000_000,
    reason: 'released',
  });

  expect(writes).toStrictEqual([
    { kind: 'changed', imp: cleared.imp, reason: 'released', detail: { released: 1 } },
  ]);
});

test('#writeMovedLeases writes a moved imp’s leases and its hold', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeMovedLeases(ctx.db, imp.id, [
    {
      principal: 'token:a',
      label: 'job',
      display: 'a',
      until: new Date(1_800_000_060_000),
      createdAt: new Date(1_800_000_000_000),
    },
  ]);

  const stored = await findImpById(ctx.db, imp.id);

  expect(stored?.holdUntil).toStrictEqual(new Date(1_800_000_060_000));
});

test('#writeMovedLeases keeps the last of a pair the header names twice', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeMovedLeases(ctx.db, imp.id, [
    {
      principal: 'token:a',
      label: 'job',
      display: 'first',
      until: new Date(1_800_000_060_000),
      createdAt: new Date(1_800_000_000_000),
    },
    {
      principal: 'token:a',
      label: 'job',
      display: 'last',
      until: null,
      createdAt: new Date(1_800_000_010_000),
    },
  ]);

  const leases = await listLeases(ctx.db, 1_800_000_000_000);

  expect(leases).toStrictEqual([
    {
      impId: imp.id,
      principal: 'token:a',
      label: 'job',
      display: 'last',
      until: null,
      createdAt: new Date(1_800_000_000_000),
    },
  ]);
});

test('#writeMovedLeases emits nothing', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const writes: ImpWrite[] = [];

  const unsubscribe = subscribeImpWrites(ctx.db, (write) => {
    writes.push(write);
  });

  onTestFinished(unsubscribe);

  await writeMovedLeases(ctx.db, imp.id, [
    {
      principal: 'token:a',
      label: 'job',
      display: 'a',
      until: null,
      createdAt: new Date(1_800_000_000_000),
    },
  ]);

  expect(writes).toStrictEqual([]);
});

test.each([
  ['token:a', 'job', 'blocking', true],
  ['token:a', 'hold', 'not blocking', false],
  ['legacy', 'job', 'not blocking', false],
  ['legacy', 'hold', 'not blocking', false],
])(
  '#isBlockingLease reports a %s lease labelled %s as %s',
  (principal, label, _verdict, expected) => {
    expect(isBlockingLease({ principal, label })).toBe(expected);
  },
);

test('#removeImp takes the imp’s leases with it', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await writeLease(ctx.db, buildMockLeaseRecord({ impId: imp.id }), {
    at: 1_800_000_000_000,
    reason: 'held',
  });

  await removeImp(ctx.db, imp.id);

  const leases = await listLeases(ctx.db, 1_800_000_000_000);

  expect(leases).toStrictEqual([]);
});

test('#runMigrations moves a live hold to a legacy lease in the lease migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '012_add_networks');

  // rows as an impd at 012 wrote them, which no current factory builds
  await db
    .insertInto('images')
    .values({ id: 'i', name: 'base', ref: 'r', digest: 'd', size_bytes: 1, created_at: 0 })
    .execute();

  const live = Date.now() + 3_600_000;

  for (const [slot, holdUntil] of [
    [0, live],
    [1, Date.now() - 1000],
    [2, null],
  ] as const) {
    await db
      .insertInto('imps')
      .values({
        id: `imp-${String(slot)}`,
        name: `imp-${String(slot)}`,
        image_id: 'i',
        state: 'running',
        vcpus: 1,
        memory_mib: 512,
        slot,
        ip: `10.66.0.${String(slot * 4 + 2)}`,
        created_at: 0,
        last_active_at: 0,
        hold_until: holdUntil,
      })
      .execute();
  }

  await runMigrations(db);

  const leases = await listLeases(db, Date.now());

  expect(leases).toStrictEqual([
    {
      impId: 'imp-0',
      principal: 'legacy',
      label: 'hold',
      display: 'legacy',
      until: new Date(live),
      createdAt: expect.toBeValidDate(),
    },
  ]);
});

test('#runMigrations clears every hold but a live one in the lease migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '012_add_networks');

  // rows as an impd at 012 wrote them, which no current factory builds
  await db
    .insertInto('images')
    .values({ id: 'i', name: 'base', ref: 'r', digest: 'd', size_bytes: 1, created_at: 0 })
    .execute();

  const live = Date.now() + 3_600_000;

  for (const [slot, holdUntil] of [
    [0, live],
    [1, Date.now() - 1000],
    [2, null],
  ] as const) {
    await db
      .insertInto('imps')
      .values({
        id: `imp-${String(slot)}`,
        name: `imp-${String(slot)}`,
        image_id: 'i',
        state: 'running',
        vcpus: 1,
        memory_mib: 512,
        slot,
        ip: `10.66.0.${String(slot * 4 + 2)}`,
        created_at: 0,
        last_active_at: 0,
        hold_until: holdUntil,
      })
      .execute();
  }

  await runMigrations(db);

  const holds = await db.selectFrom('imps').select(['id', 'hold_until']).orderBy('id').execute();

  expect(holds).toStrictEqual([
    { id: 'imp-0', hold_until: live },
    { id: 'imp-1', hold_until: null },
    { id: 'imp-2', hold_until: null },
  ]);
});
