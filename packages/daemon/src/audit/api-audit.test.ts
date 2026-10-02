import { expect, test } from 'bun:test';
import { ORPCError } from '@orpc/server';
import { listApiCalls } from '../db/api-audit';
import { setupTestDatabase } from '../db/test-database';
import { createApiAudit, isAuditedProcedure, readImpName, withAuditedOpen } from './api-audit';

test('reads, the event stream and exec tickets are not audited; a new procedure is', () => {
  expect(isAuditedProcedure('imps.list')).toBeFalse();
  expect(isAuditedProcedure('events.stream')).toBeFalse();
  expect(isAuditedProcedure('exec.ticket')).toBeFalse();
  expect(isAuditedProcedure('imps.sleep')).toBeTrue();
  expect(isAuditedProcedure('imps.someday')).toBeTrue();
});

test('the imp is an imp namespace’s input name, or the created imp’s', () => {
  expect(readImpName('imps.stop', { name: 'dev' }, {})).toBe('dev');
  expect(readImpName('imps.create', {}, { name: 'fresh' })).toBe('fresh');
  expect(readImpName('secrets.add', { name: 'gh', value: 'v' }, {})).toBeNull();
  expect(readImpName('images.delete', { name: 'ubuntu' }, {})).toBeNull();
});

test('an open is audited with its outcome, and a failed write is logged', async () => {
  await using ctx = await setupTestDatabase();

  const logs: string[] = [];

  const audit = createApiAudit({
    db: ctx.db,
    now: () => 1000,
    log: (line) => {
      logs.push(line);
    },
  });

  const call = { procedure: 'ssh', actor: 'ssh' as const, impName: 'dev', startedAt: 990 };

  await withAuditedOpen(audit, call, () => Promise.resolve('stream'));

  const refused = withAuditedOpen(audit, call, () =>
    Promise.reject(new ORPCError('INVALID_STATE', { message: 'dev is stopped' })),
  );

  const failure = await refused.catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(ORPCError);

  // each row lands after its call returns
  await waitUntil(async () => {
    const rows = await listApiCalls(ctx.db, 'dev', 10);

    return rows.length === 2;
  });

  const calls = await listApiCalls(ctx.db, 'dev', 10);

  expect(calls.map((row) => [row.procedure, row.actor, row.outcome, row.durationMs])).toEqual([
    ['ssh', 'ssh', 'INVALID_STATE', 10],
    ['ssh', 'ssh', 'ok', 10],
  ]);

  await ctx.db.schema.dropTable('api_audit').execute();

  audit.record(call, null);

  await waitUntil(() => Promise.resolve(logs.length > 0));

  expect(logs).toHaveLength(1);
  expect(logs[0]).toStartWith('impd: audit: ssh:');
});

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;

  for (;;) {
    const met = await check();

    if (met) {
      return;
    }

    if (Date.now() > deadline) {
      throw new Error('the condition never held');
    }

    await Bun.sleep(1);
  }
}
