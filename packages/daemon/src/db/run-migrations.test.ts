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

test('the grantable migration gives each secret its own generation and its old file', async () => {
  const db = openUnmigrated();

  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  });

  await migrator.migrateTo('019_add_imp_max_memory');

  for (const name of ['gh', 'npm']) {
    await sql`INSERT INTO secrets (name, kind, rules, created_at)
      VALUES (${name}, 'custom', '[]', 0)`.execute(db);
  }

  await sql`INSERT INTO tokens (id, name, secret_hash, scope, imps, created_at)
    VALUES ('t', 'ci', 'hash', 'manage', '["dev-*"]', 0)`.execute(db);

  await migrator.migrateToLatest();

  const secrets = await db
    .selectFrom('secrets')
    .select(['name', 'generation', 'value_file'])
    .orderBy('name')
    .execute();

  const token = await db.selectFrom('tokens').select('grantable').executeTakeFirst();

  expect(secrets.map((row) => [row.name, row.value_file])).toEqual([
    ['gh', 'gh'],
    ['npm', 'npm'],
  ]);

  expect(secrets.every((row) => /^[0-9a-f]{24}$/v.test(row.generation))).toBeTrue();
  expect(secrets[0]?.generation).not.toBe(secrets[1]?.generation);
  expect(token).toEqual({ grantable: '[]' });

  await db.destroy();
});
