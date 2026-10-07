import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { createSecretFiles } from '../broker/secret-files';
import { BunSqliteDriver } from './bun-sqlite-driver';
import { MIGRATIONS } from './run-migrations';
import type { DatabaseSchema } from './schema';
import { listGrantedRules } from './secrets';

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

  const rules = JSON.stringify([
    { host: 'api.example.com', header: 'authorization', scheme: 'bearer' },
  ]);

  for (const name of ['gh', 'npm']) {
    await sql`INSERT INTO secrets (name, kind, rules, created_at)
      VALUES (${name}, 'custom', ${rules}, 0)`.execute(db);
  }

  // an older impd kept each value in a file named after its secret
  const dataDir = mkdtempSync(join(tmpdir(), 'imp-migrate-'));
  const files = createSecretFiles(dataDir);

  files.write('gh', 'old-value');

  await sql`INSERT INTO images (id, name, ref, digest, size_bytes, created_at)
    VALUES ('img', 'base', 'imp/base:latest', 'sha256:0', 1, 0)`.execute(db);

  await sql`INSERT INTO imps (id, name, image_id, state, vcpus, memory_mib, slot, ip,
    created_at, last_active_at)
    VALUES ('imp', 'dev', 'img', 'stopped', 1, 512, 0, 'ip', 0, 0)`.execute(db);

  await sql`INSERT INTO grants (imp_id, secret_name) VALUES ('imp', 'gh')`.execute(db);

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

  const grants = await db.selectFrom('grants').selectAll().execute();

  expect(secrets.every((row) => /^[0-9a-f]{32}$/v.test(row.generation))).toBeTrue();

  expect(grants).toEqual([
    { imp_id: 'imp', secret_name: 'gh', secret_generation: secrets[0]?.generation ?? '' },
  ]);

  expect(secrets[0]?.generation).not.toBe(secrets[1]?.generation);
  expect(token).toEqual({ grantable: '[]' });

  // the broker reads the old file through the migrated row
  const granted = await listGrantedRules(db, 'imp');

  expect(granted.map((each) => files.read(each.valueFile))).toEqual(['old-value']);

  rmSync(dataDir, { recursive: true, force: true });

  await db.destroy();
});

test('the oauth migration leaves existing secrets without an oauth config', async () => {
  const db = openUnmigrated();

  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  });

  await migrator.migrateTo('025_add_api_audit_detail');

  const rules = JSON.stringify([
    { host: 'api.example.com', header: 'authorization', scheme: 'bearer' },
  ]);

  await sql`INSERT INTO secrets (name, kind, rules, created_at, generation, value_file)
    VALUES ('gh', 'custom', ${rules}, 0, 'g', 'gh.a1')`.execute(db);

  await migrator.migrateToLatest();

  const rows = await db.selectFrom('secrets').select(['name', 'oauth']).execute();

  expect(rows).toEqual([{ name: 'gh', oauth: null }]);

  await db.destroy();
});
