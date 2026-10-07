import { expect, test } from 'bun:test';
import { setupTestDatabase } from '../test-utils/create-test-database';
import { API_AUDIT_ROWS, listApiCalls, writeApiCall } from './api-audit';

// the most rows one insert may bind: sqlite allows 32766 variables, 6 a row
const INSERT_BATCH = 5000;

test('the log keeps the newest rows up to its cap, and one imp’s on request', async () => {
  await using ctx = await setupTestDatabase();

  const rows = Array.from({ length: API_AUDIT_ROWS }, (_, index) => ({
    at: index,
    procedure: 'imps.stop',
    actor: 'token' as const,
    imp_name: index === 0 ? 'oldest' : 'dev',
    outcome: 'ok',
    duration_ms: 1,
  }));

  for (let start = 0; start < rows.length; start += INSERT_BATCH) {
    await ctx.db
      .insertInto('api_audit')
      .values(rows.slice(start, start + INSERT_BATCH))
      .execute();
  }

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

  const oldest = await listApiCalls(ctx.db, 'oldest', 10, null);
  const newest = await listApiCalls(ctx.db, 'new', 10, null);
  const three = await listApiCalls(ctx.db, null, 3, null);

  expect(oldest).toEqual([]);

  expect(newest).toEqual([
    {
      at: new Date(API_AUDIT_ROWS),
      procedure: 'imps.create',
      actor: 'dashboard',
      actorName: 'laptop',
      imp: 'new',
      outcome: 'CONFLICT',
      durationMs: 12,
    },
  ]);

  expect(three).toHaveLength(3);
});

test('with imp patterns, it lists only calls that named a matching imp', async () => {
  await using ctx = await setupTestDatabase();

  for (const impName of ['dev-a', 'dev-b', 'prod', null]) {
    await writeApiCall(ctx.db, {
      at: new Date(1),
      procedure: impName === null ? 'images.add' : 'imps.stop',
      actor: 'token',
      actorName: 'ci',
      impName,
      outcome: 'ok',
      durationMs: 1,
      detail: null,
    });
  }

  const matching = await listApiCalls(ctx.db, null, 10, ['dev-*']);
  const all = await listApiCalls(ctx.db, null, 10, null);

  expect(matching.map((call) => call.imp)).toEqual(['dev-b', 'dev-a']);
  expect(all).toHaveLength(4);
});

test("an image add's row keeps the reference its pull resolved", async () => {
  await using ctx = await setupTestDatabase();

  const pulled = `docker.io/library/busybox@sha256:${'b'.repeat(64)}`;

  await writeApiCall(ctx.db, {
    at: new Date(1),
    procedure: 'images.add',
    actor: 'token',
    actorName: 'ci',
    impName: null,
    outcome: 'ok',
    durationMs: 9000,
    detail: pulled,
  });

  const calls = await listApiCalls(ctx.db, null, 10, null);

  expect(calls.map((call) => call.detail)).toEqual([pulled]);
});
