import { expect, test } from 'bun:test';
import { sql } from 'kysely';
import { createTestDatabase } from '../test-utils/create-test-database';
import { API_AUDIT_ROWS, listApiCalls, writeApiCall } from './api-audit';

test('#writeApiCall keeps the row count at its cap', async () => {
  const ctx = await createTestDatabase();

  await sql`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ${API_AUDIT_ROWS})
    INSERT INTO api_audit (at, procedure, actor, imp_name, outcome, duration_ms)
    SELECT i, 'imps.stop', 'token', 'dev', 'ok', 1 FROM n`.execute(ctx.db);

  await writeApiCall(ctx.db, {
    at: new Date(API_AUDIT_ROWS),
    procedure: 'imps.create',
    actor: 'dashboard',
    actorName: 'laptop',
    impName: 'new',
    outcome: 'CONFLICT',
    durationMs: 12,
    detail: null,
  });

  const count = await ctx.db
    .selectFrom('api_audit')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow();

  expect(count.count).toBe(API_AUDIT_ROWS);
});

test('#writeApiCall drops the oldest row once the log is past its cap', async () => {
  const ctx = await createTestDatabase();

  await sql`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ${API_AUDIT_ROWS})
    INSERT INTO api_audit (at, procedure, actor, imp_name, outcome, duration_ms)
    SELECT i, 'imps.stop', 'token', CASE WHEN i = 0 THEN 'oldest' ELSE 'dev' END, 'ok', 1
    FROM n`.execute(ctx.db);

  await writeApiCall(ctx.db, {
    at: new Date(API_AUDIT_ROWS),
    procedure: 'imps.create',
    actor: 'dashboard',
    actorName: 'laptop',
    impName: 'new',
    outcome: 'CONFLICT',
    durationMs: 12,
    detail: null,
  });

  const calls = await listApiCalls(ctx.db, 'oldest', 10, null);

  expect(calls).toStrictEqual([]);
});

test('#listApiCalls lists the calls that named one imp', async () => {
  const ctx = await createTestDatabase();

  await writeApiCall(ctx.db, {
    at: new Date(1),
    procedure: 'imps.stop',
    actor: 'token',
    actorName: 'ci',
    impName: 'other',
    outcome: 'ok',
    durationMs: 1,
    detail: null,
  });

  await writeApiCall(ctx.db, {
    at: new Date(2),
    procedure: 'imps.create',
    actor: 'dashboard',
    actorName: 'laptop',
    impName: 'new',
    outcome: 'CONFLICT',
    durationMs: 12,
    detail: null,
  });

  const calls = await listApiCalls(ctx.db, 'new', 10, null);

  expect(calls).toStrictEqual([
    {
      at: new Date(2),
      procedure: 'imps.create',
      actor: 'dashboard',
      actorName: 'laptop',
      imp: 'new',
      outcome: 'CONFLICT',
      durationMs: 12,
    },
  ]);
});

test('#listApiCalls leaves out the actor name and imp of an older row that named neither', async () => {
  const ctx = await createTestDatabase();

  // a row from before named tokens has no actor name
  await ctx.db
    .insertInto('api_audit')
    .values({ at: 1, procedure: 'images.add', actor: 'token', outcome: 'ok', duration_ms: 3 })
    .execute();

  const calls = await listApiCalls(ctx.db, null, 10, null);

  expect(calls).toStrictEqual([
    { at: new Date(1), procedure: 'images.add', actor: 'token', outcome: 'ok', durationMs: 3 },
  ]);
});

test('#listApiCalls lists at most the limit, newest first', async () => {
  const ctx = await createTestDatabase();

  for (const procedure of ['imps.create', 'imps.stop', 'imps.start', 'imps.sleep']) {
    await writeApiCall(ctx.db, {
      at: new Date(1),
      procedure,
      actor: 'token',
      actorName: 'ci',
      impName: 'dev',
      outcome: 'ok',
      durationMs: 1,
      detail: null,
    });
  }

  const calls = await listApiCalls(ctx.db, null, 3, null);

  expect(calls.map((call) => call.procedure)).toStrictEqual([
    'imps.sleep',
    'imps.start',
    'imps.stop',
  ]);
});

test('#listApiCalls lists only calls that named an imp within the patterns', async () => {
  const ctx = await createTestDatabase();

  for (const impName of ['dev-a', 'dev-b', 'prod', null]) {
    await writeApiCall(ctx.db, {
      at: new Date(1),
      procedure: 'imps.stop',
      actor: 'token',
      actorName: 'ci',
      impName,
      outcome: 'ok',
      durationMs: 1,
      detail: null,
    });
  }

  const matching = await listApiCalls(ctx.db, null, 10, ['dev-*']);

  expect(matching.map((call) => call.imp)).toStrictEqual(['dev-b', 'dev-a']);
});

test('#listApiCalls keeps the reference an image add’s pull resolved', async () => {
  const ctx = await createTestDatabase();

  await writeApiCall(ctx.db, {
    at: new Date(1),
    procedure: 'images.add',
    actor: 'token',
    actorName: 'ci',
    impName: null,
    outcome: 'ok',
    durationMs: 9000,
    detail: `docker.io/library/busybox@sha256:${'b'.repeat(64)}`,
  });

  const calls = await listApiCalls(ctx.db, null, 10, null);

  expect(calls.map((call) => call.detail)).toStrictEqual([
    `docker.io/library/busybox@sha256:${'b'.repeat(64)}`,
  ]);
});
