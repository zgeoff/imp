import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import { openDatabase } from '../db/open-database';
import { findSecret } from '../db/secrets';
import { setupImpTest } from '../imps/test-imps';
import { createBroker } from './broker-service';

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
