import { expect, test } from 'bun:test';
import { API_AUDIT_ROWS, listApiCalls, writeApiCall } from './api-audit';
import { setupTestDatabase } from './test-database';

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
    impName: 'new',
    outcome: 'CONFLICT',
    durationMs: 12,
  });

  const count = await ctx.db
    .selectFrom('api_audit')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow();

  expect(count.count).toBe(API_AUDIT_ROWS);

  const oldest = await listApiCalls(ctx.db, 'oldest', 10);
  const newest = await listApiCalls(ctx.db, 'new', 10);
  const three = await listApiCalls(ctx.db, null, 3);

  expect(oldest).toEqual([]);

  expect(newest).toEqual([
    {
      at: new Date(API_AUDIT_ROWS),
      procedure: 'imps.create',
      actor: 'dashboard',
      imp: 'new',
      outcome: 'CONFLICT',
      durationMs: 12,
    },
  ]);

  expect(three).toHaveLength(3);
});
