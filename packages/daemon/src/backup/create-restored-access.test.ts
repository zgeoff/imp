import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@impz/test-utils/invariant';
import { loadTokenStore } from '../auth/token-store';
import { writeConsistentCopy } from '../db/database-copy';
import { runMigrationsTo } from '../db/run-migrations';
import { createSecret, findSecret } from '../db/secrets';
import { writeTokenRecord } from '../db/tokens';
import { buildMockTokenRecord } from '../test-utils/build-mock-token-record';
import { createTestDatabase } from '../test-utils/create-test-database';
import { createUnmigratedDatabase } from '../test-utils/create-unmigrated-database';
import { runSql } from '../test-utils/run-sql';
import { createRestoredAccess } from './create-restored-access';

// This host's database and token store, and a directory for the copy a test
// writes from a database of its own.
async function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'impd-restored-access-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const host = await createTestDatabase();

  const tokens = await loadTokenStore({
    db: host.db,
    rootToken: 'root-secret',
    now: Date.now,
    onRemove: () => {},
    isFileKey: () => false,
  });

  return { db: host.db, tokens, copyPath: join(dir, 'copy.sqlite') };
}

test('it writes the copy’s secrets and tokens, each secret with its generation and value file', async () => {
  const ctx = await setupTest();
  const source = await createTestDatabase();

  const secret = await createSecret(source.db, {
    name: 'gh',
    kind: 'github',
    rules: [],
    valueFile: 'gh.0123456789abcdef',
  });

  invariant(secret);

  await writeTokenRecord(
    source.db,
    buildMockTokenRecord({
      name: 'agent',
      scope: 'manage',
      imps: ['dev'],
      grantable: [{ name: 'gh', generation: secret.generation }],
    }),
    [],
  );

  await writeConsistentCopy(source.db, ctx.copyPath);

  const result = await createRestoredAccess(ctx.db, ctx.tokens, ctx.copyPath);
  const restored = await findSecret(ctx.db, 'gh');

  expect(result).toStrictEqual({ tokens: ['agent'], secrets: ['gh'], skipped: [] });
  expect(restored).toStrictEqual(secret);
});

test('it keeps this host’s own secret under a name the copy has', async () => {
  const ctx = await setupTest();
  const source = await createTestDatabase();

  await createSecret(source.db, {
    name: 'gh',
    kind: 'github',
    rules: [],
    valueFile: 'gh.0123456789abcdef',
  });

  await createSecret(ctx.db, { name: 'gh', kind: 'github', rules: [], valueFile: 'gh.here' });
  await writeConsistentCopy(source.db, ctx.copyPath);

  const result = await createRestoredAccess(ctx.db, ctx.tokens, ctx.copyPath);
  const kept = await findSecret(ctx.db, 'gh');

  expect(result.secrets).toStrictEqual([]);
  expect(kept?.valueFile).toBe('gh.here');
});

test('it migrates a copy from an older impd forward before it reads the copy', async () => {
  const ctx = await setupTest();

  // an impd from before grantable lists and secret generations
  const source = createUnmigratedDatabase();

  await runMigrationsTo(source, '019_add_imp_max_memory');

  await runSql(
    source,
    `INSERT INTO secrets (name, kind, rules, created_at)
    VALUES ('gh', 'github', '[]', 1790000000000)`,
  );

  await runSql(
    source,
    `INSERT INTO tokens (id, name, secret_hash, scope, imps, created_at)
    VALUES ('tok0123456789abc', 'agent', ?, 'exec', NULL, 1790000000000)`,
    ['ab'.repeat(32)],
  );

  await writeConsistentCopy(source, ctx.copyPath);

  const result = await createRestoredAccess(ctx.db, ctx.tokens, ctx.copyPath);
  const restored = await findSecret(ctx.db, 'gh');

  expect(result).toStrictEqual({ tokens: ['agent'], secrets: ['gh'], skipped: [] });
  expect(restored?.generation).toMatch(/^[0-9a-f]{32}$/v);
});

test('it refuses a copy from a newer impd and writes nothing', async () => {
  const ctx = await setupTest();
  const source = await createTestDatabase();

  await createSecret(source.db, { name: 'gh', kind: 'github', rules: [], valueFile: 'gh' });

  await runSql(
    source.db,
    `INSERT INTO kysely_migration (name, timestamp)
    VALUES ('999_from_a_newer_impd', '2030-01-01T00:00:00.000Z')`,
  );

  await writeConsistentCopy(source.db, ctx.copyPath);

  const tokens = { createRestored: mock() };

  expect(createRestoredAccess(ctx.db, tokens, ctx.copyPath)).rejects.toThrow(
    /the database is at migration 999_from_a_newer_impd, newer than this impd's last/v,
  );

  const found = await findSecret(ctx.db, 'gh');

  expect(found).toBeUndefined();
  expect(tokens.createRestored).not.toHaveBeenCalled();
});

test('it leaves out a secret whose value file names a path outside the secrets directory', async () => {
  const ctx = await setupTest();
  const source = await createTestDatabase();

  await createSecret(source.db, { name: 'gh', kind: 'github', rules: [], valueFile: '../token' });

  await createSecret(source.db, {
    name: 'npm',
    kind: 'npm',
    rules: [],
    valueFile: 'npm.0123456789abcdef',
  });

  await writeConsistentCopy(source.db, ctx.copyPath);

  const result = await createRestoredAccess(ctx.db, ctx.tokens, ctx.copyPath);
  const found = await findSecret(ctx.db, 'gh');

  expect(result).toStrictEqual({
    tokens: [],
    secrets: ['npm'],
    skipped: [{ name: 'gh', reason: 'secret gh: its value file is not a name impd gives' }],
  });

  expect(found).toBeUndefined();
});
