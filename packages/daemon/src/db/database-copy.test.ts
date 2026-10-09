import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { sql } from 'kysely';
import { createDiskBudget } from '../storage/disk-budget';
import { createUnmigratedDatabase } from '../test-utils/create-unmigrated-database';
import { writeConsistentCopy, writeDatabaseCopy } from './database-copy';
import { openDatabase } from './open-database';
import { MIGRATIONS, runMigrationsTo } from './run-migrations';

// a data dir for the copies, and impd's database, injected as the copy takes
// it; both gone when the test finishes
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = mkdtempSync(join(tmpdir(), 'impd-db-copy-'));

  stack.defer(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  return { dataDir, db };
}

test('#writeDatabaseCopy returns the copy’s path, size, schema version and integrity', async () => {
  const ctx = await setupTest();

  // 10 GiB free past a 1 GiB reserve
  const budget = createDiskBudget({
    storage: {
      readUsage: () => Promise.resolve({ usedBytes: 1024 ** 3, availableBytes: 10 * 1024 ** 3 }),
    },
    reserveBytes: 1024 ** 3,
    log: () => {},
  });

  const copy = await writeDatabaseCopy(
    ctx.db,
    budget,
    ctx.dataDir,
    'nightly',
    () => 1_800_000_000_000,
  );

  const lastMigration = Object.keys(MIGRATIONS).toSorted().at(-1);
  const written = statSync(join(ctx.dataDir, 'db-copies', 'nightly.sqlite'));

  invariant(lastMigration);

  expect(copy).toStrictEqual({
    path: join(ctx.dataDir, 'db-copies', 'nightly.sqlite'),
    sizeBytes: written.size,
    lastMigration,
    integrity: 'ok',
    createdAt: new Date(1_800_000_000_000),
  });
});

test('#writeDatabaseCopy makes the copy readable by its owner only', async () => {
  const ctx = await setupTest();

  const budget = createDiskBudget({
    storage: {
      readUsage: () => Promise.resolve({ usedBytes: 1024 ** 3, availableBytes: 10 * 1024 ** 3 }),
    },
    reserveBytes: 1024 ** 3,
    log: () => {},
  });

  await writeDatabaseCopy(ctx.db, budget, ctx.dataDir, 'nightly', Date.now);

  expect(statSync(join(ctx.dataDir, 'db-copies', 'nightly.sqlite')).mode & 0o777).toBe(0o600);
});

test('#writeDatabaseCopy makes an existing copies directory owner-only', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dataDir, 'db-copies'), { mode: 0o755 });

  const budget = createDiskBudget({
    storage: {
      readUsage: () => Promise.resolve({ usedBytes: 1024 ** 3, availableBytes: 10 * 1024 ** 3 }),
    },
    reserveBytes: 1024 ** 3,
    log: () => {},
  });

  await writeDatabaseCopy(ctx.db, budget, ctx.dataDir, 'mode', Date.now);

  expect(statSync(join(ctx.dataDir, 'db-copies')).mode & 0o777).toBe(0o700);
});

test('#writeDatabaseCopy takes a whole copy while writes run', async () => {
  const ctx = await setupTest();

  const budget = createDiskBudget({
    storage: {
      readUsage: () => Promise.resolve({ usedBytes: 1024 ** 3, availableBytes: 10 * 1024 ** 3 }),
    },
    reserveBytes: 1024 ** 3,
    log: () => {},
  });

  const writes = Array.from({ length: 200 }, (_, index) =>
    sql`INSERT INTO api_audit (at, procedure, actor, outcome, duration_ms)
      VALUES (${index}, 'test.write', 'token', 'ok', 0)`.execute(ctx.db),
  );

  const [copy] = await Promise.all([
    writeDatabaseCopy(ctx.db, budget, ctx.dataDir, 'busy', Date.now),
    ...writes,
  ]);

  const opened = new Database(copy.path, { readonly: true });

  onTestFinished(() => {
    opened.close();
  });

  expect(opened.query('PRAGMA integrity_check').all()).toStrictEqual([{ integrity_check: 'ok' }]);
});

test('#writeDatabaseCopy holds a prefix of the writes that run meanwhile', async () => {
  const ctx = await setupTest();

  const budget = createDiskBudget({
    storage: {
      readUsage: () => Promise.resolve({ usedBytes: 1024 ** 3, availableBytes: 10 * 1024 ** 3 }),
    },
    reserveBytes: 1024 ** 3,
    log: () => {},
  });

  const writes = Array.from({ length: 200 }, (_, index) =>
    sql`INSERT INTO api_audit (at, procedure, actor, outcome, duration_ms)
      VALUES (${index}, 'test.write', 'token', 'ok', 0)`.execute(ctx.db),
  );

  const [copy] = await Promise.all([
    writeDatabaseCopy(ctx.db, budget, ctx.dataDir, 'busy', Date.now),
    ...writes,
  ]);

  const opened = new Database(copy.path, { readonly: true });

  onTestFinished(() => {
    opened.close();
  });

  const ats = opened
    .query<{ at: number }, []>('SELECT at FROM api_audit ORDER BY at')
    .all()
    .map((row) => row.at);

  expect(ats).toStrictEqual(Array.from({ length: ats.length }, (_, index) => index));
});

test('#writeDatabaseCopy refuses a copy past the disk reserve, and leaves no file', async () => {
  const ctx = await setupTest();

  // the reserve and not a byte more: the copy needs room past it
  const budget = createDiskBudget({
    storage: {
      readUsage: () => Promise.resolve({ usedBytes: 1024 ** 3, availableBytes: 1024 ** 3 }),
    },
    reserveBytes: 1024 ** 3,
    log: () => {},
  });

  const refused = writeDatabaseCopy(ctx.db, budget, ctx.dataDir, 'full', Date.now);

  await refused.catch(() => {});

  expect(refused).rejects.toMatchObject({ code: 'DISK_FULL' });
  expect(readdirSync(join(ctx.dataDir, 'db-copies'))).toStrictEqual([]);
});

test('#writeDatabaseCopy refuses a name a copy already has, and keeps that copy', async () => {
  const ctx = await setupTest();

  const budget = createDiskBudget({
    storage: {
      readUsage: () => Promise.resolve({ usedBytes: 1024 ** 3, availableBytes: 10 * 1024 ** 3 }),
    },
    reserveBytes: 1024 ** 3,
    log: () => {},
  });

  mkdirSync(join(ctx.dataDir, 'db-copies'));
  writeFileSync(join(ctx.dataDir, 'db-copies', 'nightly.sqlite'), 'an earlier copy');

  const refused = writeDatabaseCopy(ctx.db, budget, ctx.dataDir, 'nightly', Date.now);

  await refused.catch(() => {});

  expect(refused).rejects.toMatchObject({
    code: 'CONFLICT',
    data: { kind: 'database-copy', name: 'nightly' },
  });

  const kept = await Bun.file(join(ctx.dataDir, 'db-copies', 'nightly.sqlite')).text();

  expect(kept).toBe('an earlier copy');
});

test('#writeDatabaseCopy removes the half-written copy of a copy that fails', async () => {
  const ctx = await setupTest();

  const budget = createDiskBudget({
    storage: {
      readUsage: () => Promise.resolve({ usedBytes: 1024 ** 3, availableBytes: 10 * 1024 ** 3 }),
    },
    reserveBytes: 1024 ** 3,
    log: () => {},
  });

  // VACUUM INTO cannot run inside a transaction, so the copy step fails
  const failed = ctx.db
    .transaction()
    .execute((trx) => writeDatabaseCopy(trx, budget, ctx.dataDir, 'nightly', Date.now));

  await failed.catch(() => {});

  expect(failed).rejects.toThrowWithMessage(Error, /cannot VACUUM from within a transaction/u);
  expect(readdirSync(join(ctx.dataDir, 'db-copies'))).toStrictEqual([]);
});

test('#writeConsistentCopy writes into an empty file that exists', async () => {
  const ctx = await setupTest();

  const path = join(ctx.dataDir, 'empty.sqlite');

  writeFileSync(path, '');

  await writeConsistentCopy(ctx.db, path);

  const opened = new Database(path, { readonly: true });

  onTestFinished(() => {
    opened.close();
  });

  const names = opened
    .query<{ name: string }, []>('SELECT name FROM kysely_migration ORDER BY name')
    .all()
    .map((row) => row.name);

  expect(names).toStrictEqual(Object.keys(MIGRATIONS).toSorted());
});

test('#writeConsistentCopy writes a copy of an older schema that migrates forward on open', async () => {
  const ctx = await setupTest();

  const restored = join(ctx.dataDir, 'restored.sqlite');

  // an older impd's database, as `imp db copy` of that impd wrote it
  const older = createUnmigratedDatabase(join(ctx.dataDir, 'older.sqlite'));

  await runMigrationsTo(older, '020_add_grantable_secrets');
  await writeConsistentCopy(older, restored);

  const db = await openDatabase(restored);

  await db.destroy();

  const opened = new Database(restored, { readonly: true });

  onTestFinished(() => {
    opened.close();
  });

  const names = opened
    .query<{ name: string }, []>('SELECT name FROM kysely_migration ORDER BY name')
    .all()
    .map((row) => row.name);

  expect(names).toStrictEqual(Object.keys(MIGRATIONS).toSorted());
});
