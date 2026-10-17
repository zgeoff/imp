import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcp } from '@better-auth/mcp';
import type { BetterAuthPlugin } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { sql } from 'kysely';
import invariant from 'tiny-invariant';
import { createSecretFiles } from '../broker/secret-files';
import { createUnmigratedDatabase } from '../test-utils/create-unmigrated-database';
import { findImpByName } from './imps';
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
    '029_add_token_image_ref_prefix',
    '030_add_broker_audit_refusals',
  ]);
});

test('#runMigrations refuses a database a newer impd migrated, naming both versions', async () => {
  const db = createUnmigratedDatabase();

  await runMigrations(db);

  await sql`INSERT INTO kysely_migration (name, timestamp)
    VALUES ('999_from_a_newer_impd', '2030-01-01T00:00:00.000Z')`.execute(db);

  const last = Object.keys(MIGRATIONS).toSorted().at(-1);

  invariant(last !== undefined);

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

  invariant(older !== undefined);

  // a newer impd's database, one migration short of this impd's last and
  // holding one this impd never had
  await runMigrationsTo(db, older);

  await sql`INSERT INTO kysely_migration (name, timestamp)
    VALUES ('999_from_a_newer_impd', '2030-01-01T00:00:00.000Z')`.execute(db);

  const last = names.at(-1);

  invariant(last !== undefined);

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
    { imp_id: 'imp', secret_name: 'gh', secret_generation: secret.generation, filter: null },
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

test('#runMigrations leaves every existing grant on the whole host in the grant filter migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '030_add_broker_audit_refusals');

  // rows as an impd at 030 wrote them
  await sql`INSERT INTO secrets (name, kind, rules, created_at, generation, value_file)
    VALUES ('gh', 'custom', '[]', 0, 'g1', 'gh-file')`.execute(db);

  await sql`INSERT INTO images (id, name, ref, digest, size_bytes, created_at)
    VALUES ('img', 'base', 'imp/base:latest', 'sha256:0', 1, 0)`.execute(db);

  await sql`INSERT INTO imps (id, name, image_id, state, vcpus, memory_mib, slot, ip,
    created_at, last_active_at)
    VALUES ('imp', 'dev', 'img', 'stopped', 1, 512, 0, 'ip', 0, 0)`.execute(db);

  await sql`INSERT INTO grants (imp_id, secret_name, secret_generation)
    VALUES ('imp', 'gh', 'g1')`.execute(db);

  await runMigrations(db);

  const grants = await db.selectFrom('grants').selectAll().execute();

  expect(grants).toStrictEqual([
    { imp_id: 'imp', secret_name: 'gh', secret_generation: 'g1', filter: null },
  ]);
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

test('#runMigrations keeps every broker audit row as a sent request in the refusals migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '029_add_token_image_ref_prefix');

  // rows as an impd at 029 wrote them
  await sql`INSERT INTO images (id, name, ref, digest, size_bytes, created_at)
    VALUES ('img', 'base', 'imp/base:latest', 'sha256:0', 1, 0)`.execute(db);

  await sql`INSERT INTO imps (id, name, image_id, state, vcpus, memory_mib, slot, ip,
    created_at, last_active_at)
    VALUES ('imp', 'dev', 'img', 'stopped', 1, 512, 0, 'ip', 0, 0)`.execute(db);

  await sql`INSERT INTO broker_audit (id, imp_id, secret_name, at, method, host, path, status,
    request_bytes, response_bytes, duration_ms)
    VALUES (7, 'imp', 'gh', 1, 'GET', 'api.github.com', '/user', 200, 2, 3, 4)`.execute(db);

  await runMigrations(db);

  const rows = await db.selectFrom('broker_audit').selectAll().execute();

  expect(rows).toStrictEqual([
    {
      id: 7,
      imp_id: 'imp',
      secret_name: 'gh',
      at: 1,
      method: 'GET',
      host: 'api.github.com',
      path: '/user',
      status: 200,
      request_bytes: 2,
      response_bytes: 3,
      duration_ms: 4,
      reason: null,
    },
  ]);
});

test('#runMigrations makes an imp’s delete remove its broker audit rows in the refusals migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '029_add_token_image_ref_prefix');

  // rows as an impd at 029 wrote them
  await sql`INSERT INTO images (id, name, ref, digest, size_bytes, created_at)
    VALUES ('img', 'base', 'imp/base:latest', 'sha256:0', 1, 0)`.execute(db);

  await sql`INSERT INTO imps (id, name, image_id, state, vcpus, memory_mib, slot, ip,
    created_at, last_active_at)
    VALUES ('gone', 'dev', 'img', 'stopped', 1, 512, 0, 'ip-1', 0, 0),
      ('kept', 'ops', 'img', 'stopped', 1, 512, 1, 'ip-2', 0, 0)`.execute(db);

  await sql`INSERT INTO broker_audit (imp_id, secret_name, at, method, host, path, status,
    request_bytes, response_bytes, duration_ms)
    VALUES ('gone', 'gh', 1, 'GET', 'api.github.com', '/user', 200, 0, 0, 0),
      ('kept', 'gh', 1, 'GET', 'api.github.com', '/user', 200, 0, 0, 0)`.execute(db);

  await runMigrations(db);

  await db.deleteFrom('imps').where('id', '=', 'gone').execute();

  const rows = await db.selectFrom('broker_audit').select('imp_id').execute();

  expect(rows).toStrictEqual([{ imp_id: 'kept' }]);
});

test('#runMigrations keeps the broker audit index in the refusals migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrations(db);

  const indexes = await sql<{ name: string; sql: string }>`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'index' AND tbl_name = 'broker_audit' AND sql IS NOT NULL
  `.execute(db);

  expect(indexes.rows).toStrictEqual([
    {
      name: 'broker_audit_imp_id',
      sql: 'CREATE INDEX "broker_audit_imp_id" on "broker_audit" ("imp_id", "id")',
    },
  ]);
});

test('#runMigrations adds only the oops boot id column to the imps in the oops boot id migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '031_add_grant_filter');

  const before = await sql<{ name: string; type: string; notnull: number; dflt_value: null }>`
    SELECT name, type, "notnull", dflt_value FROM pragma_table_info('imps')
  `.execute(db);

  await runMigrationsTo(db, '032_add_imp_oops_boot_id');

  const after = await sql<{ name: string; type: string; notnull: number; dflt_value: null }>`
    SELECT name, type, "notnull", dflt_value FROM pragma_table_info('imps')
  `.execute(db);

  expect(after.rows).toStrictEqual([
    ...before.rows,
    { name: 'oops_boot_id', type: 'TEXT', notnull: 0, dflt_value: null },
  ]);
});

test('#runMigrations keeps a kernel oops hold an older impd wrote in the oops boot id migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '031_add_grant_filter');

  // rows as an impd at 031 wrote them: a hold, with no boot recorded
  await sql`INSERT INTO images (id, name, ref, digest, size_bytes, created_at)
    VALUES ('img', 'base', 'imp/base:latest', 'sha256:0', 1, 0)`.execute(db);

  await sql`INSERT INTO imps (id, name, image_id, state, vcpus, memory_mib, slot, ip,
    created_at, last_active_at, error)
    VALUES ('imp', 'dev', 'img', 'stopped', 1, 512, 0, 'ip', 0, 0,
      'a kernel oops killed firecracker')`.execute(db);

  await runMigrations(db);

  const imp = await findImpByName(db, 'dev');

  expect(imp).toMatchObject({ error: 'a kernel oops killed firecracker', oopsBootId: null });
});

test('#runMigrations adds only the oops hold column to the imps in the oops hold migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '032_add_imp_oops_boot_id');

  const before = await sql<{ name: string; type: string; notnull: number; dflt_value: unknown }>`
    SELECT name, type, "notnull", dflt_value FROM pragma_table_info('imps')
  `.execute(db);

  await runMigrations(db);

  const after = await sql<{ name: string; type: string; notnull: number; dflt_value: unknown }>`
    SELECT name, type, "notnull", dflt_value FROM pragma_table_info('imps')
  `.execute(db);

  expect(after.rows).toStrictEqual([
    ...before.rows,
    { name: 'oops_hold', type: 'INTEGER', notnull: 1, dflt_value: '0' },
  ]);
});

test('#runMigrations carries each kernel oops hold into its own column in the oops hold migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '032_add_imp_oops_boot_id');

  // rows as an impd at 032 wrote them: a hold of this boot, one from before
  // 032 with no boot, another error, and no error
  await sql`INSERT INTO images (id, name, ref, digest, size_bytes, created_at)
    VALUES ('img', 'base', 'imp/base:latest', 'sha256:0', 1, 0)`.execute(db);

  await sql`INSERT INTO imps (id, name, image_id, state, vcpus, memory_mib, slot, ip,
    created_at, last_active_at, error, oops_boot_id)
    VALUES
      ('a', 'held', 'img', 'stopped', 1, 512, 0, 'ip0', 0, 0,
        'a kernel oops killed firecracker', 'boot-1'),
      ('b', 'held-before-032', 'img', 'sleeping', 1, 512, 1, 'ip1', 0, 0,
        'a kernel oops killed firecracker', NULL),
      ('c', 'oom', 'img', 'stopped', 1, 512, 2, 'ip2', 0, 0,
        'its memory limit killed firecracker', NULL),
      ('d', 'fine', 'img', 'stopped', 1, 512, 3, 'ip3', 0, 0, NULL, NULL)`.execute(db);

  await runMigrations(db);

  const imps = await Promise.all(
    ['held', 'held-before-032', 'oom', 'fine'].map((name) => findImpByName(db, name)),
  );

  expect(
    imps.map((imp) => ({
      name: imp?.name,
      hasOopsHold: imp?.hasOopsHold,
      error: imp?.error,
      oopsBootId: imp?.oopsBootId,
    })),
  ).toStrictEqual([
    {
      name: 'held',
      hasOopsHold: true,
      error: 'a kernel oops killed firecracker',
      oopsBootId: 'boot-1',
    },
    {
      name: 'held-before-032',
      hasOopsHold: true,
      error: 'a kernel oops killed firecracker',
      oopsBootId: null,
    },
    {
      name: 'oom',
      hasOopsHold: false,
      error: 'its memory limit killed firecracker',
      oopsBootId: null,
    },
    { name: 'fine', hasOopsHold: false, error: null, oopsBootId: null },
  ]);
});

test('#runMigrations adds only better-auth’s tables in the better-auth migration', async () => {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '033_add_imp_oops_hold');

  const before = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `.execute(db);

  await runMigrations(db);

  const after = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `.execute(db);

  expect(after.rows.map((row) => row.name)).toIncludeSameMembers([
    ...before.rows.map((row) => row.name),
    'user',
    'session',
    'account',
    'verification',
    'oauthClient',
    'oauthResource',
    'oauthClientResource',
    'oauthRefreshToken',
    'oauthAccessToken',
    'oauthConsent',
    'oauthClientAssertion',
  ]);
});

test('#runMigrations leaves better-auth no table or column to add', async () => {
  const db = createUnmigratedDatabase();

  await runMigrations(db);

  const options = {
    baseURL: 'http://127.0.0.1:7071',
    basePath: '/',
    secret: 'a-test-secret-of-at-least-32-characters',
    database: { db, type: 'sqlite' as const },
    telemetry: { enabled: false },
    logger: { disabled: true },
    user: {
      additionalFields: {
        tokenId: { type: 'string' as const, required: true, input: false },
        imps: { type: 'string' as const, required: false, input: false },
        lastUsedAt: { type: 'date' as const, required: false, input: false },
      },
    },
    plugins: [
      // oxlint-disable-next-line no-unsafe-type-assertion -- a BetterAuthPlugin at runtime; only its endpoint option types disagree with the stricter compiler settings
      mcp({
        loginPage: '/login',
        consentPage: '/consent',
        scopes: ['read', 'exec', 'manage', 'offline_access'],
        disableJwtPlugin: true,
        resource: 'http://127.0.0.1:7071/mcp',
      }) as BetterAuthPlugin,
    ],
  };

  const pending = await getMigrations(options);

  expect(pending.toBeCreated).toStrictEqual([]);
  expect(pending.toBeAdded).toStrictEqual([]);
});
