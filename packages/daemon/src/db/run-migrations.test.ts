import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { sql } from 'kysely';
import { createSecretFiles } from '../broker/secret-files';
import { createUnmigratedDatabase } from '../test-utils/create-unmigrated-database';
import { MIGRATIONS, runMigrations, runMigrationsTo } from './run-migrations';
import { listGrantedRules } from './secrets';

test('#runMigrations migrates an empty database to the last migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrations(db);

  const ran = await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY name`.execute(
    db,
  );

  expect(ran.rows.map((row) => row.name)).toStrictEqual(Object.keys(MIGRATIONS).toSorted());
});

// A database records each migration by name, and a name it ran that this
// impd lacks refuses the upgrade, so a released migration keeps its name
test('#runMigrations keeps the name of each migration a released impd ran', () => {
  expect(Object.keys(MIGRATIONS).toSorted()).toIncludeAllMembers([
    '001_create_initial_schema',
    '002_add_imp_http_port',
    '003_add_broker',
    '004_add_api_audit',
    '005_add_disk_sizes',
    '006_add_tokens',
    '007_add_egress_allow',
    '008_add_token_ssh_keys',
    '009_add_imp_cpu',
    '010_add_image_source',
    '011_add_public_exposure',
    '012_add_networks',
    '013_add_imp_leases',
    '014_add_moves',
    '015_add_cold_boots',
    '016_add_imp_jail_uid',
    '017_add_move_slots',
    '018_add_warm_moves',
    '019_add_imp_max_memory',
    '020_add_grantable_secrets',
    '021_add_broker_sessions',
    '022_add_mcp_oauth',
    '023_add_secret_file_removals',
    '024_add_imp_kind',
    '025_add_api_audit_detail',
    '026_add_secret_oauth',
    '027_add_imp_backup',
    '028_cascade_oauth_tokens',
  ]);
});

test('#runMigrations refuses a database a newer impd migrated, naming both versions', async () => {
  const db = createUnmigratedDatabase();

  await runMigrations(db);

  await sql`INSERT INTO kysely_migration (name, timestamp)
    VALUES ('999_from_a_newer_impd', '2030-01-01T00:00:00.000Z')`.execute(db);

  const last = Object.keys(MIGRATIONS).toSorted().at(-1);

  invariant(last);

  expect(runMigrations(db)).rejects.toThrowWithMessage(
    Error,
    `the database is at migration 999_from_a_newer_impd, newer than this impd's last, ${last}: start the impd that wrote it or a newer one, or restore an older database copy (docs/guides/operations.md#database-copy-and-restore)`,
  );
});

test('#runMigrations runs nothing on a database file a newer impd migrated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-migrate-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const db = createUnmigratedDatabase(join(dir, 'imp.sqlite'));
  const names = Object.keys(MIGRATIONS).toSorted();
  const older = names.at(-2);

  invariant(older);

  // a newer impd's database, one migration short of this impd's last and
  // holding one this impd never had
  await runMigrationsTo(db, older);

  await sql`INSERT INTO kysely_migration (name, timestamp)
    VALUES ('999_from_a_newer_impd', '2030-01-01T00:00:00.000Z')`.execute(db);

  const last = names.at(-1);

  invariant(last);

  // the refusal's own message: Kysely also rejects a migration it does not
  // know, so only the message shows that impd refused before Kysely ran
  expect(runMigrations(db)).rejects.toThrowWithMessage(
    Error,
    `the database is at migration 999_from_a_newer_impd, newer than this impd's last, ${last}: start the impd that wrote it or a newer one, or restore an older database copy (docs/guides/operations.md#database-copy-and-restore)`,
  );

  const ran = await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY name`.execute(
    db,
  );

  expect(ran.rows.map((row) => row.name)).toStrictEqual([
    ...names.slice(0, -1),
    '999_from_a_newer_impd',
  ]);
});

test('#runMigrations rethrows the error of a migration that fails', async () => {
  const db = createUnmigratedDatabase();

  // a table by the name the first migration makes, so its create fails
  await sql`CREATE TABLE images (id TEXT)`.execute(db);

  expect(runMigrations(db)).rejects.toThrowWithMessage(Error, 'table "images" already exists');
});

test('#runMigrationsTo rethrows the error a migration throws', () => {
  const db = createUnmigratedDatabase();

  const failed = runMigrationsTo(db, '001_fails', {
    '001_fails': { up: () => Promise.reject(new Error('the disk went away')) },
  });

  expect(failed).rejects.toThrowWithMessage(Error, 'the disk went away');
});

test('#runMigrationsTo wraps a failure that is not an Error, keeping it as the cause', () => {
  const db = createUnmigratedDatabase();

  const failed = runMigrationsTo(db, '001_fails', {
    // oxlint-disable-next-line prefer-promise-reject-errors -- the non-Error a migration may throw is the case under test
    '001_fails': { up: () => Promise.reject('the disk went away') },
  });

  expect(failed).rejects.toMatchObject({
    message: 'kysely migration failed',
    cause: 'the disk went away',
  });
});

test('#runMigrationsTo stops at the migration it names', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '002_add_imp_http_port');

  const ran = await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY name`.execute(
    db,
  );

  expect(ran.rows.map((row) => row.name)).toStrictEqual([
    '001_create_initial_schema',
    '002_add_imp_http_port',
  ]);
});

test('#runMigrations numbers existing imps in order of creation in the jail uid migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '011_add_public_exposure');

  // rows as an impd at 011 wrote them
  await sql`INSERT INTO images (id, name, ref, digest, size_bytes, created_at)
    VALUES ('img', 'base', 'imp/base:latest', 'sha256:0', 1, 0)`.execute(db);

  await sql`INSERT INTO imps (id, name, image_id, state, vcpus, memory_mib, slot, ip,
    created_at, last_active_at)
    VALUES ('late', 'late', 'img', 'stopped', 1, 512, 20, 'late', 20, 0),
      ('early', 'early', 'img', 'stopped', 1, 512, 10, 'early', 10, 0)`.execute(db);

  await runMigrations(db);

  const rows = await db.selectFrom('imps').select(['id', 'jail_uid']).orderBy('id').execute();

  expect(rows).toStrictEqual([
    { id: 'early', jail_uid: 900_000 },
    { id: 'late', jail_uid: 900_001 },
  ]);
});

test('#runMigrations gives each secret its own generation in the grantable migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '019_add_imp_max_memory');

  // rows as an impd at 019 wrote them
  await sql`INSERT INTO secrets (name, kind, rules, created_at)
    VALUES ('gh', 'custom', '[]', 0), ('npm', 'custom', '[]', 0)`.execute(db);

  await runMigrations(db);

  const secrets = await db
    .selectFrom('secrets')
    .select(['name', 'generation'])
    .orderBy('name')
    .execute();

  expect(secrets).toStrictEqual([
    { name: 'gh', generation: expect.toSatisfy((hex: string) => /^[0-9a-f]{32}$/v.test(hex)) },
    { name: 'npm', generation: expect.toSatisfy((hex: string) => /^[0-9a-f]{32}$/v.test(hex)) },
  ]);

  expect(new Set(secrets.map((row) => row.generation)).size).toBe(2);
});

test('#runMigrations keeps each secret’s value in its old file in the grantable migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '019_add_imp_max_memory');

  // rows as an impd at 019 wrote them
  await sql`INSERT INTO secrets (name, kind, rules, created_at)
    VALUES ('gh', 'custom', '[]', 0), ('npm', 'custom', '[]', 0)`.execute(db);

  await runMigrations(db);

  const secrets = await db
    .selectFrom('secrets')
    .select(['name', 'value_file'])
    .orderBy('name')
    .execute();

  expect(secrets).toStrictEqual([
    { name: 'gh', value_file: 'gh' },
    { name: 'npm', value_file: 'npm' },
  ]);
});

test('#runMigrations gives a grant its secret’s generation in the grantable migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '019_add_imp_max_memory');

  // rows as an impd at 019 wrote them
  await sql`INSERT INTO secrets (name, kind, rules, created_at)
    VALUES ('gh', 'custom', '[]', 0)`.execute(db);

  await sql`INSERT INTO images (id, name, ref, digest, size_bytes, created_at)
    VALUES ('img', 'base', 'imp/base:latest', 'sha256:0', 1, 0)`.execute(db);

  await sql`INSERT INTO imps (id, name, image_id, state, vcpus, memory_mib, slot, ip,
    created_at, last_active_at)
    VALUES ('imp', 'dev', 'img', 'stopped', 1, 512, 0, 'ip', 0, 0)`.execute(db);

  await sql`INSERT INTO grants (imp_id, secret_name) VALUES ('imp', 'gh')`.execute(db);

  await runMigrations(db);

  const secret = await db
    .selectFrom('secrets')
    .select('generation')
    .where('name', '=', 'gh')
    .executeTakeFirstOrThrow();

  const grants = await db.selectFrom('grants').selectAll().execute();

  expect(grants).toStrictEqual([
    { imp_id: 'imp', secret_name: 'gh', secret_generation: secret.generation },
  ]);
});

test('#runMigrations lets a token grant no secret in the grantable migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '019_add_imp_max_memory');

  // a row as an impd at 019 wrote it
  await sql`INSERT INTO tokens (id, name, secret_hash, scope, imps, created_at)
    VALUES ('t', 'ci', 'hash', 'manage', '["dev-*"]', 0)`.execute(db);

  await runMigrations(db);

  const token = await db
    .selectFrom('tokens')
    .select('grantable')
    .where('id', '=', 't')
    .executeTakeFirstOrThrow();

  expect(token.grantable).toBe('[]');
});

test('#runMigrations lets an existing token add no image in the image ref prefix migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '028_cascade_oauth_tokens');

  // a row as an impd at 028 wrote it
  await sql`INSERT INTO tokens (id, name, secret_hash, scope, imps, grantable, created_at)
    VALUES ('t', 'ci', 'hash', 'manage', '["dev-*"]', '[]', 0)`.execute(db);

  await runMigrations(db);

  const token = await db
    .selectFrom('tokens')
    .select('image_ref_prefix')
    .where('id', '=', 't')
    .executeTakeFirstOrThrow();

  expect(token.image_ref_prefix).toBeNull();
});

test('#runMigrations leaves the broker reading the old value file in the grantable migration', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'imp-migrate-'));

  onTestFinished(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '019_add_imp_max_memory');

  // an older impd kept each value in a file named after its secret
  const files = createSecretFiles(dataDir);

  files.write('gh', 'old-value');

  // rows as an impd at 019 wrote them
  const rules = JSON.stringify([
    { host: 'api.example.com', header: 'authorization', scheme: 'bearer' },
  ]);

  await sql`INSERT INTO secrets (name, kind, rules, created_at)
    VALUES ('gh', 'custom', ${rules}, 0)`.execute(db);

  await sql`INSERT INTO images (id, name, ref, digest, size_bytes, created_at)
    VALUES ('img', 'base', 'imp/base:latest', 'sha256:0', 1, 0)`.execute(db);

  await sql`INSERT INTO imps (id, name, image_id, state, vcpus, memory_mib, slot, ip,
    created_at, last_active_at)
    VALUES ('imp', 'dev', 'img', 'stopped', 1, 512, 0, 'ip', 0, 0)`.execute(db);

  await sql`INSERT INTO grants (imp_id, secret_name) VALUES ('imp', 'gh')`.execute(db);

  await runMigrations(db);

  const granted = await listGrantedRules(db, 'imp');

  expect(granted.map((each) => files.read(each.valueFile))).toStrictEqual(['old-value']);
});

test('#runMigrations leaves existing secrets without an oauth config in the oauth migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '025_add_api_audit_detail');

  // a row as an impd at 025 wrote it
  await sql`INSERT INTO secrets (name, kind, rules, created_at, generation, value_file)
    VALUES ('gh', 'custom', '[]', 0, 'g', 'gh.a1')`.execute(db);

  await runMigrations(db);

  const rows = await db.selectFrom('secrets').select(['name', 'oauth']).execute();

  expect(rows).toStrictEqual([{ name: 'gh', oauth: null }]);
});

test('#runMigrations keeps every OAuth token in the token cascade migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '027_add_imp_backup');

  // rows as an impd at 027 wrote them
  await sql`INSERT INTO tokens (id, name, secret_hash, scope, imps, created_at)
    VALUES ('tok', 'laptop', 'h', 'admin', NULL, 0)`.execute(db);

  await sql`INSERT INTO oauth_clients (id, name, redirect_uris, created_at)
    VALUES ('client', 'claude', '[]', 0)`.execute(db);

  await sql`INSERT INTO oauth_grants (id, client_id, token_id, scope, imps, resource, created_at)
    VALUES ('grant', 'client', 'tok', 'admin', NULL, 'https://impd.test/mcp', 0)`.execute(db);

  await sql`INSERT INTO oauth_tokens
    (id, grant_id, kind, secret_hash, created_at, expires_at, spent_at)
    VALUES ('access', 'grant', 'access', 'ha', 1, 2, NULL),
      ('refresh', 'grant', 'refresh', 'hr', 3, 4, 5)`.execute(db);

  await runMigrations(db);

  const rows = await db.selectFrom('oauth_tokens').selectAll().orderBy('id').execute();

  expect(rows).toStrictEqual([
    {
      id: 'access',
      grant_id: 'grant',
      kind: 'access',
      secret_hash: 'ha',
      created_at: 1,
      expires_at: 2,
      spent_at: null,
    },
    {
      id: 'refresh',
      grant_id: 'grant',
      kind: 'refresh',
      secret_hash: 'hr',
      created_at: 3,
      expires_at: 4,
      spent_at: 5,
    },
  ]);
});

test('#runMigrations makes a grant’s delete remove its tokens in the token cascade migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '027_add_imp_backup');

  // rows as an impd at 027 wrote them
  await sql`INSERT INTO tokens (id, name, secret_hash, scope, imps, created_at)
    VALUES ('tok', 'laptop', 'h', 'admin', NULL, 0)`.execute(db);

  await sql`INSERT INTO oauth_clients (id, name, redirect_uris, created_at)
    VALUES ('client', 'claude', '[]', 0)`.execute(db);

  await sql`INSERT INTO oauth_grants (id, client_id, token_id, scope, imps, resource, created_at)
    VALUES ('gone', 'client', 'tok', 'admin', NULL, 'https://impd.test/mcp', 0),
      ('kept', 'client', 'tok', 'admin', NULL, 'https://impd.test/mcp', 0)`.execute(db);

  await sql`INSERT INTO oauth_tokens
    (id, grant_id, kind, secret_hash, created_at, expires_at, spent_at)
    VALUES ('gone-access', 'gone', 'access', 'h1', 0, 1, NULL),
      ('kept-access', 'kept', 'access', 'h2', 0, 1, NULL)`.execute(db);

  await runMigrations(db);

  await db.deleteFrom('oauth_grants').where('id', '=', 'gone').execute();

  const rows = await db.selectFrom('oauth_tokens').select('id').execute();

  expect(rows).toStrictEqual([{ id: 'kept-access' }]);
});

test('#runMigrations keeps the OAuth token indexes in the token cascade migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrations(db);

  const indexes = await sql<{ name: string; sql: string }>`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'oauth_tokens' AND sql IS NOT NULL
    ORDER BY name
  `.execute(db);

  expect(indexes.rows).toStrictEqual([
    {
      name: 'oauth_tokens_expires_at',
      sql: 'CREATE INDEX "oauth_tokens_expires_at" on "oauth_tokens" ("expires_at")',
    },
    {
      name: 'oauth_tokens_grant_id',
      sql: 'CREATE INDEX "oauth_tokens_grant_id" on "oauth_tokens" ("grant_id")',
    },
  ]);
});
