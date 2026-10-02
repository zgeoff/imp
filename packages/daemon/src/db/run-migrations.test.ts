import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { BunSqliteDriver } from './bun-sqlite-driver';
import { MIGRATIONS } from './run-migrations';
import type { DatabaseSchema } from './schema';

function openUnmigrated(): Kysely<DatabaseSchema> {
  const sqlite = new Database(':memory:');

  return new Kysely<DatabaseSchema>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new BunSqliteDriver(sqlite),
      createIntrospector: (kysely) => new SqliteIntrospector(kysely),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });
}

test('the jail uid migration numbers existing imps in order of creation', async () => {
  const db = openUnmigrated();

  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  });

  await migrator.migrateTo('011_add_public_exposure');

  await sql`INSERT INTO images (id, name, ref, digest, size_bytes, created_at)
    VALUES ('img', 'base', 'imp/base:latest', 'sha256:0', 1, 0)`.execute(db);

  for (const [id, createdAt] of [
    ['late', 20],
    ['early', 10],
  ] as const) {
    await sql`INSERT INTO imps (id, name, image_id, state, vcpus, memory_mib, slot, ip,
      created_at, last_active_at)
      VALUES (${id}, ${id}, 'img', 'stopped', 1, 512, ${createdAt}, ${id}, ${createdAt}, 0)`.execute(
      db,
    );
  }

  await migrator.migrateToLatest();

  const rows = await db.selectFrom('imps').select(['id', 'jail_uid']).orderBy('id').execute();

  expect(rows).toEqual([
    { id: 'early', jail_uid: 900_000 },
    { id: 'late', jail_uid: 900_001 },
  ]);

  await db.destroy();
});
