import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import { setupTestDatabase } from '../test-utils/create-test-database';
import { BunSqliteDriver } from './bun-sqlite-driver';
import { subscribeImpWrites } from './imp-write-feed';
import type { ImpWrite } from './imp-write-feed';
import { createImp, findImpById } from './imps';
import { isBlockingLease, listLeases, removeLeases, writeLease } from './leases';
import type { LeaseRecord } from './leases';
import { runMigrations, runMigrationsTo } from './run-migrations';
import type { DatabaseSchema } from './schema';

const AT = 1_800_000_000_000;

async function setupTest() {
  const database = await setupTestDatabase();

  const imp = await createImp(database.db, {
    name: 'dev',
    imageId: database.image.id,
    vcpus: 1,
    memoryMib: 512,
    slot: 0,
    ip: '10.66.0.2',
  });

  const writes: ImpWrite[] = [];

  subscribeImpWrites(database.db, (write) => {
    writes.push(write);
  });

  const buildLease = (overrides: Partial<LeaseRecord>): LeaseRecord => ({
    impId: imp.id,
    principal: 'token:a',
    label: 'job',
    display: 'a',
    until: new Date(AT + 60_000),
    createdAt: new Date(AT),
    ...overrides,
  });

  return { ...database, imp, writes, buildLease };
}

test('the hold is the latest end of the live leases, and no end beats every end', async () => {
  await using ctx = await setupTest();

  const first = await writeLease(ctx.db, ctx.buildLease({}), { at: AT, reason: 'held' });

  const later = new Date(AT + 120_000);

  const second = await writeLease(ctx.db, ctx.buildLease({ principal: 'token:b', until: later }), {
    at: AT,
    reason: 'held',
  });

  expect(first.holdUntil).toEqual(new Date(AT + 60_000));
  expect(second.holdUntil).toEqual(later);

  const endless = await writeLease(ctx.db, ctx.buildLease({ principal: 'token:c', until: null }), {
    at: AT,
    reason: null,
  });

  expect(endless.holdUntil?.getTime()).toBeGreaterThan(later.getTime());

  const removed = await removeLeases(ctx.db, ctx.imp.id, [{ principal: 'token:c', label: 'job' }], {
    at: AT,
    reason: 'held',
  });

  const stored = await findImpById(ctx.db, ctx.imp.id);

  expect(removed.imp.holdUntil).toEqual(later);
  expect(stored?.holdUntil).toEqual(later);
});

test('a write moves the end and keeps when the lease was made', async () => {
  await using ctx = await setupTest();

  await writeLease(ctx.db, ctx.buildLease({}), { at: AT, reason: 'held' });

  await writeLease(
    ctx.db,
    ctx.buildLease({ until: new Date(AT + 90_000), createdAt: new Date(AT + 30_000) }),
    { at: AT + 30_000, reason: null },
  );

  const [lease] = await listLeases(ctx.db, AT + 30_000);

  expect(lease?.until).toEqual(new Date(AT + 90_000));
  expect(lease?.createdAt).toEqual(new Date(AT));

  // a renew emits nothing
  expect(ctx.writes.map((write) => write.kind === 'changed' && write.reason)).toEqual(['held']);
});

test('a lease past its end is gone from the list, and a later write prunes it', async () => {
  await using ctx = await setupTest();

  await writeLease(ctx.db, ctx.buildLease({}), { at: AT, reason: 'held' });

  const before = await listLeases(ctx.db, AT + 59_999);
  const after = await listLeases(ctx.db, AT + 60_000);

  expect(before).toHaveLength(1);
  expect(after).toEqual([]);

  // it comes back as a new lease
  const at = AT + 61_000;

  await writeLease(
    ctx.db,
    ctx.buildLease({ until: new Date(at + 10_000), createdAt: new Date(at) }),
    { at, reason: 'held' },
  );

  const [lease] = await listLeases(ctx.db, at);

  expect(lease?.createdAt).toEqual(new Date(at));
});

test('two owners each remove only their own lease', async () => {
  await using ctx = await setupTest();

  await writeLease(ctx.db, ctx.buildLease({}), { at: AT, reason: 'held' });

  await writeLease(ctx.db, ctx.buildLease({ principal: 'token:b', display: 'b' }), {
    at: AT,
    reason: 'held',
  });

  const removed = await removeLeases(ctx.db, ctx.imp.id, [{ principal: 'token:b', label: 'job' }], {
    at: AT,
    reason: 'held',
  });

  const again = await removeLeases(ctx.db, ctx.imp.id, [{ principal: 'token:b', label: 'job' }], {
    at: AT,
    reason: 'held',
  });

  expect(removed.removed).toBe(1);
  expect(again.removed).toBe(0);

  const left = await listLeases(ctx.db, AT);

  expect(left.map((lease) => lease.principal)).toEqual(['token:a']);

  // a removal that took nothing emits nothing
  expect(ctx.writes).toHaveLength(3);
});

test('a forced clear takes only the leases made through leases.*', async () => {
  await using ctx = await setupTest();

  for (const lease of [
    ctx.buildLease({}),
    ctx.buildLease({ label: 'other' }),
    ctx.buildLease({ label: 'hold' }),
    ctx.buildLease({ principal: 'legacy', label: 'hold', display: 'legacy' }),
  ]) {
    await writeLease(ctx.db, lease, { at: AT, reason: null });
  }

  const cleared = await removeLeases(ctx.db, ctx.imp.id, 'blocking', {
    at: AT,
    reason: 'released',
  });

  const left = await listLeases(ctx.db, AT);

  expect(cleared.removed).toBe(2);

  expect(left.map((lease) => `${lease.principal}/${lease.label}`)).toEqual([
    'legacy/hold',
    'token:a/hold',
  ]);

  expect(left.some((lease) => isBlockingLease(lease))).toBeFalse();

  expect(ctx.writes.at(-1)).toMatchObject({
    kind: 'changed',
    reason: 'released',
    detail: { released: 2 },
  });
});

test('a destroy takes the leases with the imp', async () => {
  await using ctx = await setupTest();

  await writeLease(ctx.db, ctx.buildLease({}), { at: AT, reason: 'held' });

  await ctx.db.deleteFrom('imps').where('id', '=', ctx.imp.id).execute();

  const left = await listLeases(ctx.db, AT);

  expect(left).toEqual([]);
});

test('the migration moves a live hold to legacy, and drops one that ended', async () => {
  const sqlite = new Database(':memory:');

  sqlite.run('PRAGMA foreign_keys = ON;');

  await using db = Object.assign(
    new Kysely<DatabaseSchema>({
      dialect: {
        createAdapter: () => new SqliteAdapter(),
        createDriver: () => new BunSqliteDriver(sqlite),
        createIntrospector: (kysely) => new SqliteIntrospector(kysely),
        createQueryCompiler: () => new SqliteQueryCompiler(),
      },
    }),
    { [Symbol.asyncDispose]: () => db.destroy() },
  );

  await runMigrationsTo(db, '012_add_networks');

  const now = Date.now();

  await db
    .insertInto('images')
    .values({ id: 'i', name: 'base', ref: 'r', digest: 'd', size_bytes: 1, created_at: now })
    .execute();

  for (const [slot, holdUntil] of [
    [0, now + 3_600_000],
    [1, now - 1000],
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
        created_at: now,
        last_active_at: now,
        slept_at: null,
        hold_until: holdUntil,
        error: null,
        pid: null,
        firecracker_version: null,
        cpu_limit: null,
        awake_since: null,
        public_auth: null,
        public_user: null,
        public_hash: null,
      })
      .execute();
  }

  await runMigrations(db);

  const leases = await listLeases(db, now);
  const holds = await db.selectFrom('imps').select(['id', 'hold_until']).orderBy('id').execute();

  expect(leases).toMatchObject([
    {
      impId: 'imp-0',
      principal: 'legacy',
      label: 'hold',
      display: 'legacy',
      until: new Date(now + 3_600_000),
    },
  ]);

  expect(holds).toEqual([
    { id: 'imp-0', hold_until: now + 3_600_000 },
    { id: 'imp-1', hold_until: null },
    { id: 'imp-2', hold_until: null },
  ]);
});
