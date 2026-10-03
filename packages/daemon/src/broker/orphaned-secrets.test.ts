import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import { openDatabase } from '../db/open-database';
import { findSecret, listFileRemovals } from '../db/secrets';
import { setupImpTest } from '../imps/test-imps';
import { createBroker } from './broker-service';
import type { Broker } from './broker-service';
import { createSecretFiles } from './secret-files';
import type { SecretFiles } from './secret-files';

// A restore puts back an older database: the values of secrets added since
// have no row, and the start keeps them aside rather than delete them
// (docs/guides/connectors.md#value-files).

test('a start on an older database keeps the newer secret values, and logs each', async () => {
  await using ctx = await setupImpTest();

  const first = await createBroker({ config: ctx.config, db: ctx.db, log: () => {} });

  const copyPath = join(ctx.dataDir, 'older.sqlite');

  try {
    await first.addSecret({ name: 'early', kind: 'github', value: 'ghp_EARLY' });

    // the copy a restore would put back, taken before the later secret
    await sql`VACUUM INTO ${copyPath}`.execute(ctx.db);
    await first.addSecret({ name: 'late', kind: 'npm', value: 'npm_LATE' });
  } finally {
    await first.stop();
  }

  const late = await findSecret(ctx.db, 'late');
  const older = await openDatabase(copyPath);

  const logs: string[] = [];

  try {
    const restored = await createBroker({
      config: ctx.config,
      db: older,
      log: (message) => {
        logs.push(message);
      },
    });

    await restored.stop();
  } finally {
    await older.destroy();
  }

  const secrets = join(ctx.dataDir, 'secrets');
  const [kept] = readdirSync(join(secrets, '.orphaned'));
  const file = late?.valueFile ?? '';

  expect(readFileSync(join(secrets, '.orphaned', kept ?? '', file), 'utf8')).toBe('npm_LATE');
  expect(readdirSync(secrets)).not.toContain(file);
  expect(logs.join('\n')).toContain(`kept secret value file ${file}, which no database row names`);
  expect(logs.join('\n')).not.toContain('npm_LATE');
});

// A delete or a replace records the file it displaced in its transaction: a
// crash before the file goes leaves the record, and the next start removes
// the file rather than keep a deleted value aside.
test.each([
  ['a delete', (broker: Broker) => broker.deleteSecret('gone')],
  [
    'a replace',
    (broker: Broker) =>
      broker.addSecret({ name: 'gone', kind: 'github', value: 'ghp_NEW', replace: true }),
  ],
])('%s that stopped before removing the old file: the next start removes it', async (_, change) => {
  await using ctx = await setupImpTest();

  const real = createSecretFiles(ctx.dataDir);

  // impd stops between the commit and the removal
  const crashing: SecretFiles = {
    ...real,
    remove: () => {
      throw new Error('stopped');
    },
  };

  const first = await createBroker({
    config: ctx.config,
    db: ctx.db,
    log: () => {},
    secretFiles: crashing,
  });

  try {
    await first.addSecret({ name: 'gone', kind: 'github', value: 'ghp_OLD' });
  } finally {
    await first.stop();
  }

  const saved = await findSecret(ctx.db, 'gone');

  const old = saved?.valueFile ?? '';

  const second = await createBroker({
    config: ctx.config,
    db: ctx.db,
    log: () => {},
    secretFiles: crashing,
  });

  try {
    await change(second);
  } finally {
    await second.stop();
  }

  const secrets = join(ctx.dataDir, 'secrets');

  const recorded = await listFileRemovals(ctx.db);

  expect(readdirSync(secrets)).toContain(old);
  expect(recorded).toEqual([old]);

  const restarted = await createBroker({ config: ctx.config, db: ctx.db, log: () => {} });

  await restarted.stop();

  expect(readdirSync(secrets)).not.toContain(old);

  const left = await listFileRemovals(ctx.db);

  expect(readdirSync(secrets)).not.toContain('.orphaned');
  expect(left).toEqual([]);
});
