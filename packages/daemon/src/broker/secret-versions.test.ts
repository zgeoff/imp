import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import { findImpByName } from '../db/imps';
import { findSecret, upsertSecret } from '../db/secrets';
import { buildTestApp, setupImpTest } from '../imps/test-imps';
import { createBroker } from './broker-service';
import { buildValueFile, createSecretFiles } from './secret-files';

// Each value is an immutable file that the secret's row names; a rotation
// keeps the binding and its grants, a rebind drops them
// (docs/guides/connectors.md#rotate-or-rebind).

const RULES_AB = [
  { host: 'a.example.com', header: 'authorization', scheme: 'bearer' as const },
  { host: 'b.example.com', header: 'authorization', scheme: 'bearer' as const },
];

async function setupTest() {
  const harness = await setupImpTest();

  await harness.createTestImage('base');

  const ctx = { ...harness, ...buildTestApp(harness, harness) };

  await ctx.client.imps.create({ name: 'dev' });

  const dir = join(ctx.dataDir, 'secrets');

  // the files in <data>/secrets, and the one the row names with its value
  const readFiles = async (name: string) => {
    const secret = await findSecret(ctx.db, name);

    const named = secret === undefined ? null : readFileSync(join(dir, secret.valueFile), 'utf8');

    return { files: readdirSync(dir).toSorted(), named, secret };
  };

  // a broker started again on the same database and data dir
  const startBrokerAgain = async () => {
    const broker = await createBroker({ config: ctx.config, db: ctx.db, log: () => {} });

    await broker.stop();
  };

  return { ...ctx, dir, readFiles, startBrokerAgain };
}

test('a rotation keeps the generation and the grants; a reorder of the hosts is one', async () => {
  await using ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules: RULES_AB });
  await ctx.client.grants.add({ name: 'dev', secret: 'api' });

  const before = await ctx.readFiles('api');

  const rotated = await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v2',
    rules: RULES_AB.toReversed(),
    replace: true,
  });

  const after = await ctx.readFiles('api');
  const imp = await findImpByName(ctx.db, 'dev');
  const isGranted = await ctx.broker.isGranted(imp?.id ?? '', 'b.example.com');

  expect(rotated.droppedGrants).toBe(0);
  expect(after.secret?.generation).toBe(before.secret?.generation ?? '');
  expect(after.named).toBe('v2');
  expect(after.files).toEqual([after.secret?.valueFile ?? '']);
  expect(isGranted).toBeTrue();
});

test('a changed binding without rebind is CONFLICT and changes nothing', async () => {
  await using ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules: RULES_AB });
  await ctx.client.grants.add({ name: 'dev', secret: 'api' });

  const before = await ctx.readFiles('api');

  const refused = await ctx.client.secrets
    .add({
      name: 'api',
      kind: 'custom',
      value: 'v2',
      rules: [{ host: 'c.example.com', header: 'authorization', scheme: 'bearer' }],
      replace: true,
    })
    .catch((error: unknown) => error);

  const after = await ctx.readFiles('api');
  const grants = await ctx.client.grants.list({ name: 'dev' });

  expect(refused).toMatchObject({
    code: 'CONFLICT',
    data: { kind: 'secret', name: 'api', reason: 'binding_changed' },
  });

  expect(after).toEqual(before);
  expect(grants).toEqual(['api']);
});

test('a rebind takes a new generation and drops every grant of the secret', async () => {
  await using ctx = await setupTest();

  await ctx.client.imps.create({ name: 'dev-2' });
  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules: RULES_AB });
  await ctx.client.grants.add({ name: 'dev', secret: 'api' });
  await ctx.client.grants.add({ name: 'dev-2', secret: 'api' });

  const before = await ctx.readFiles('api');

  const rebound = await ctx.client.secrets.add({
    name: 'api',
    kind: 'github',
    value: 'v2',
    replace: true,
    rebind: true,
  });

  const after = await ctx.readFiles('api');
  const rows = await ctx.db.selectFrom('grants').selectAll().execute();

  expect(rebound.droppedGrants).toBe(2);
  expect(rebound.imps).toEqual([]);
  expect(rows).toEqual([]);
  expect(after.secret?.generation).not.toBe(before.secret?.generation ?? '');
  expect(after.files).toEqual([after.secret?.valueFile ?? '']);
});

test('a grant whose generation is not the secret’s gives no credential', async () => {
  await using ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules: RULES_AB });
  await ctx.client.grants.add({ name: 'dev', secret: 'api' });

  // a row left from another generation, as a bug or a hand edit would
  await ctx.db.updateTable('grants').set({ secret_generation: 'other' }).execute();

  const imp = await findImpByName(ctx.db, 'dev');
  const isGranted = await ctx.broker.isGranted(imp?.id ?? '', 'a.example.com');
  const grants = await ctx.client.grants.list({ name: 'dev' });

  expect(isGranted).toBeFalse();
  expect(grants).toEqual([]);
});

test('replaces, deletes and creates at once leave exactly the files the rows name', async () => {
  await using ctx = await setupTest();

  const writeValue = async (value: string, replace: boolean): Promise<void> => {
    try {
      await ctx.client.secrets.add({
        name: 'api',
        kind: 'custom',
        value,
        rules: RULES_AB,
        replace,
      });
    } catch {
      // a CONFLICT or NOT_FOUND from the other call is one of the orders
    }
  };

  await writeValue('v0', false);

  // two rotations, then a rotation and a delete, then a delete and a create
  await Promise.all([writeValue('v1', true), writeValue('v2', true)]);

  const rotations = await ctx.readFiles('api');

  await Promise.all([writeValue('v3', true), ctx.client.secrets.delete({ name: 'api' })]);

  const replaceDelete = await ctx.readFiles('api');

  await Promise.all([
    ctx.client.secrets.delete({ name: 'api' }).catch(() => null),
    writeValue('v4', false),
  ]);

  const deleteCreate = await ctx.readFiles('api');

  expect(rotations.files).toEqual([rotations.secret?.valueFile ?? '']);
  expect(['v1', 'v2']).toContain(rotations.named ?? '');

  for (const state of [replaceDelete, deleteCreate]) {
    const named = state.secret === undefined ? [] : [state.secret.valueFile];

    expect(state.files).toEqual(named);
  }
});

test('a replace whose commit fails removes its new file and keeps the old value', async () => {
  await using ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules: RULES_AB });

  const before = await ctx.readFiles('api');

  await sql`CREATE TRIGGER fail_update BEFORE UPDATE ON secrets
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END`.execute(ctx.db);

  const failure = await ctx.client.secrets
    .add({ name: 'api', kind: 'custom', value: 'v2', rules: RULES_AB, replace: true })
    .catch((error: unknown) => error);

  const after = await ctx.readFiles('api');

  expect(String(failure)).not.toContain('v2');
  expect(failure).toBeInstanceOf(Error);
  expect(after).toEqual(before);
});

test('a restart between the stages of a replace leaves only the value the row names', async () => {
  await using ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules: RULES_AB });

  const files = createSecretFiles(ctx.dataDir);

  const first = await ctx.readFiles('api');

  // stopped after the write: the new file has no row
  files.write(buildValueFile('api'), 'v2');

  writeFileSync(join(ctx.dir, '.api.half-written'), 'v');

  await ctx.startBrokerAgain();

  const afterWrite = await ctx.readFiles('api');

  // stopped after the commit: the row names the new file, the old one stays
  const next = buildValueFile('api');

  files.write(next, 'v3');

  await upsertSecret(
    ctx.db,
    { name: 'api', kind: 'custom', rules: RULES_AB, valueFile: next },
    false,
  );

  await ctx.startBrokerAgain();

  const afterCommit = await ctx.readFiles('api');

  // after the cleanup: nothing to remove
  await ctx.startBrokerAgain();

  const afterCleanup = await ctx.readFiles('api');

  expect(afterWrite).toEqual(first);
  expect(afterCommit).toMatchObject({ files: [next], named: 'v3' });
  expect(afterCleanup).toEqual(afterCommit);
});
