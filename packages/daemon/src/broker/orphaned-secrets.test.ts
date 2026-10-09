import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { sql } from 'kysely';
import { loadConfig } from '../config';
import { openDatabase } from '../db/open-database';
import { findSecret, listFileRemovals } from '../db/secrets';
import { createBroker } from './broker-service';

// A restore puts back an older database: the values of secrets added since
// have no row, and the start keeps them aside rather than delete them
// (docs/guides/connectors.md#value-files).

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'orphaned-secrets-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  const config = loadConfig({ IMP_DATA_DIR: dataDir });

  return { stack, config, db, dataDir };
}

test('it keeps aside a value no row of an older database names', async () => {
  const ctx = await setupTest();

  const first = await createBroker({
    config: ctx.config,
    db: ctx.db,
    log: () => {},
    runOAuthTimer: false,
  });

  ctx.stack.defer(() => first.stop());

  await first.addSecret({ name: 'early', kind: 'github', value: 'ghp_EARLY' });

  // the copy a restore would put back, taken before the later secret
  const copyPath = join(ctx.dataDir, 'older.sqlite');

  await sql`VACUUM INTO ${copyPath}`.execute(ctx.db);
  await first.addSecret({ name: 'late', kind: 'npm', value: 'npm_LATE' });
  await first.stop();

  const late = await findSecret(ctx.db, 'late');

  invariant(late);

  const older = await openDatabase(copyPath);

  ctx.stack.defer(() => older.destroy());

  const logs: string[] = [];

  const restored = await createBroker({
    config: ctx.config,
    db: older,
    runOAuthTimer: false,
    now: () => Date.parse('2026-10-04T05:30:00.000Z'),
    log: (message) => {
      logs.push(message);
    },
  });

  ctx.stack.defer(() => restored.stop());

  const kept = join(ctx.dataDir, 'secrets', '.orphaned', '2026-10-04T05-30-00.000Z');

  const value = await readFile(join(kept, late.valueFile), 'utf8');
  const left = await readdir(join(ctx.dataDir, 'secrets'));

  expect(value).toBe('npm_LATE');
  expect(left).toIncludeSameMembers(['.orphaned', expect.toStartWith('early.')]);

  expect(logs).toStrictEqual([
    `impd: broker: kept secret value file ${late.valueFile}, which no database row names, in ${kept}`,
  ]);
});

test('it removes the old file of a delete that stopped before removing it, on the next start', async () => {
  const ctx = await setupTest();

  const first = await createBroker({
    config: ctx.config,
    db: ctx.db,
    log: () => {},
    runOAuthTimer: false,
  });

  ctx.stack.defer(() => first.stop());

  await first.addSecret({ name: 'gone', kind: 'github', value: 'ghp_OLD' });

  const saved = await findSecret(ctx.db, 'gone');

  invariant(saved);

  const oldFile = join(ctx.dataDir, 'secrets', saved.valueFile);

  // a directory where the value file was: the delete's removal of it fails
  await rm(oldFile);
  await mkdir(oldFile);
  await writeFile(join(oldFile, 'held'), 'x');

  await first.deleteSecret('gone');
  await first.stop();

  // the next start finds the file again
  await rm(oldFile, { recursive: true });
  await writeFile(oldFile, 'ghp_OLD');

  const restarted = await createBroker({
    config: ctx.config,
    db: ctx.db,
    log: () => {},
    runOAuthTimer: false,
  });

  ctx.stack.defer(() => restarted.stop());

  const files = await readdir(join(ctx.dataDir, 'secrets'));
  const recorded = await listFileRemovals(ctx.db);

  expect(files).toStrictEqual([]);
  expect(recorded).toStrictEqual([]);
});

test('it removes the old file of a replace that stopped before removing it, on the next start', async () => {
  const ctx = await setupTest();

  const first = await createBroker({
    config: ctx.config,
    db: ctx.db,
    log: () => {},
    runOAuthTimer: false,
  });

  ctx.stack.defer(() => first.stop());

  await first.addSecret({ name: 'gone', kind: 'github', value: 'ghp_OLD' });

  const saved = await findSecret(ctx.db, 'gone');

  invariant(saved);

  const oldFile = join(ctx.dataDir, 'secrets', saved.valueFile);

  // a directory where the value file was: the replace's removal of it fails
  await rm(oldFile);
  await mkdir(oldFile);
  await writeFile(join(oldFile, 'held'), 'x');

  await first.addSecret({ name: 'gone', kind: 'github', value: 'ghp_NEW', replace: true });
  await first.stop();

  // the next start finds the file again
  await rm(oldFile, { recursive: true });
  await writeFile(oldFile, 'ghp_OLD');

  const restarted = await createBroker({
    config: ctx.config,
    db: ctx.db,
    log: () => {},
    runOAuthTimer: false,
  });

  ctx.stack.defer(() => restarted.stop());

  const current = await findSecret(ctx.db, 'gone');

  invariant(current);

  const files = await readdir(join(ctx.dataDir, 'secrets'));
  const recorded = await listFileRemovals(ctx.db);

  expect(files).toStrictEqual([current.valueFile]);
  expect(recorded).toStrictEqual([]);
});

test('it keeps the record of a file whose removal fails again, and keeps the file aside of the orphans', async () => {
  const ctx = await setupTest();

  const first = await createBroker({
    config: ctx.config,
    db: ctx.db,
    log: () => {},
    runOAuthTimer: false,
  });

  ctx.stack.defer(() => first.stop());

  await first.addSecret({ name: 'gone', kind: 'github', value: 'ghp_OLD' });

  const saved = await findSecret(ctx.db, 'gone');

  invariant(saved);

  const oldFile = join(ctx.dataDir, 'secrets', saved.valueFile);

  // a directory where the value file was: every removal of it fails
  await rm(oldFile);
  await mkdir(oldFile);
  await writeFile(join(oldFile, 'held'), 'x');

  await first.deleteSecret('gone');
  await first.stop();

  const logs: string[] = [];

  const restarted = await createBroker({
    config: ctx.config,
    db: ctx.db,
    runOAuthTimer: false,
    log: (message) => {
      logs.push(message);
    },
  });

  ctx.stack.defer(() => restarted.stop());

  const files = await readdir(join(ctx.dataDir, 'secrets'));
  const recorded = await listFileRemovals(ctx.db);

  expect(files).toStrictEqual([saved.valueFile]);
  expect(recorded).toStrictEqual([saved.valueFile]);

  expect(logs).toStrictEqual([
    expect.toStartWith('impd: broker: could not remove an old secret value file: '),
  ]);
});

test('it never removes a recorded file that a row still names', async () => {
  const ctx = await setupTest();

  const first = await createBroker({
    config: ctx.config,
    db: ctx.db,
    log: () => {},
    runOAuthTimer: false,
  });

  ctx.stack.defer(() => first.stop());

  await first.addSecret({ name: 'kept', kind: 'github', value: 'ghp_KEPT' });
  await first.stop();

  const saved = await findSecret(ctx.db, 'kept');

  invariant(saved);

  // a record naming the live file, as a bug or a hand edit would leave
  await ctx.db
    .insertInto('secret_file_removals')
    .values({ value_file: saved.valueFile, created_at: Date.now() })
    .execute();

  const restarted = await createBroker({
    config: ctx.config,
    db: ctx.db,
    log: () => {},
    runOAuthTimer: false,
  });

  ctx.stack.defer(() => restarted.stop());

  const value = await readFile(join(ctx.dataDir, 'secrets', saved.valueFile), 'utf8');
  const recorded = await listFileRemovals(ctx.db);

  expect(value).toBe('ghp_KEPT');
  expect(recorded).toStrictEqual([]);
});
