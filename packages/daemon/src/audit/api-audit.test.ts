import { expect, test } from 'bun:test';
import { waitFor } from '@imp/test-utils/wait-for';
import { ORPCError } from '@orpc/server';
import { listApiCalls } from '../db/api-audit';
import { createTestDatabase } from '../test-utils/create-test-database';
import { createApiAudit, readImpName, withAuditedOpen } from './api-audit';

async function setupTest() {
  const database = await createTestDatabase();

  // the audit's clock, which a test sets to the time it needs
  const clock = { at: 0 };
  const logs: string[] = [];

  const audit = createApiAudit({
    db: database.db,
    now: () => clock.at,
    log: (line) => {
      logs.push(line);
    },
  });

  return { db: database.db, clock, logs, audit };
}

test.each([
  ['imps.stop', { name: 'dev' }, {}, 'dev'],
  ['checkpoints.create', { name: 'dev', label: 'before' }, {}, 'dev'],
  ['imps.create', {}, { name: 'fresh' }, 'fresh'],
  ['images.add', { name: 'snap', imp: 'dev' }, {}, 'dev'],
  ['images.addStream', { name: 'snap', imp: 'dev' }, {}, 'dev'],
  ['secrets.add', { name: 'gh', value: 'v' }, {}, null],
  ['images.delete', { name: 'ubuntu' }, {}, null],
  ['imps.stop', { name: 42 }, {}, null],
  ['imps.list', null, [], null],
])(
  '#readImpName reads the imp of %s from %j and %j as %p',
  (procedure, input, output, expected) => {
    expect(readImpName(procedure, input, output)).toBe(expected);
  },
);

test('#withAuditedOpen records an open that succeeds as ok, with its duration', async () => {
  const ctx = await setupTest();

  ctx.clock.at = 1000;

  const opened = await withAuditedOpen(
    ctx.audit,
    {
      procedure: 'ssh',
      actor: { kind: 'ssh', name: 'laptop' },
      impName: 'dev',
      startedAt: 990,
      detail: 'port 22',
    },
    () => Promise.resolve('stream'),
  );

  const calls = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, 'dev', 10, null);

    expect(rows).toHaveLength(1);

    return rows;
  });

  expect(opened).toBe('stream');

  expect(calls).toStrictEqual([
    {
      at: new Date(1000),
      procedure: 'ssh',
      actor: 'ssh',
      actorName: 'laptop',
      imp: 'dev',
      outcome: 'ok',
      durationMs: 10,
      detail: 'port 22',
    },
  ]);
});

test('#withAuditedOpen records the code of a refused open and rethrows its error', async () => {
  const ctx = await setupTest();

  const refusal = new ORPCError('INVALID_STATE', { message: 'dev is stopped' });

  const opening = withAuditedOpen(
    ctx.audit,
    { procedure: 'ssh', actor: { kind: 'ssh', name: 'laptop' }, impName: 'dev', startedAt: 990 },
    () => Promise.reject(refusal),
  );

  expect(opening).rejects.toBe(refusal);

  const calls = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, 'dev', 10, null);

    expect(rows).toHaveLength(1);

    return rows;
  });

  expect(calls.map((call) => call.outcome)).toStrictEqual(['INVALID_STATE']);
});

test('#withAuditedOpen records an open that throws a plain error as INTERNAL_SERVER_ERROR', async () => {
  const ctx = await setupTest();

  const opening = withAuditedOpen(
    ctx.audit,
    { procedure: 'exec', actor: { kind: 'token', name: 'ci' }, impName: 'dev', startedAt: 990 },
    () => Promise.reject(new Error('socket closed')),
  );

  expect(opening).rejects.toThrowWithMessage(Error, 'socket closed');

  const calls = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, 'dev', 10, null);

    expect(rows).toHaveLength(1);

    return rows;
  });

  expect(calls.map((call) => call.outcome)).toStrictEqual(['INTERNAL_SERVER_ERROR']);
});

test('#createApiAudit records a call that started after the clock reads as taking 0 ms', async () => {
  const ctx = await setupTest();

  ctx.clock.at = 1000;

  ctx.audit.record(
    {
      procedure: 'imps.stop',
      actor: { kind: 'token', name: 'root' },
      impName: 'dev',
      startedAt: 1200,
    },
    null,
  );

  const calls = await waitFor(async () => {
    const rows = await listApiCalls(ctx.db, 'dev', 10, null);

    expect(rows).toHaveLength(1);

    return rows;
  });

  expect(calls.map((call) => call.durationMs)).toStrictEqual([0]);
});

test('#createApiAudit logs a row it could not write', async () => {
  const ctx = await setupTest();

  await ctx.db.schema.dropTable('api_audit').execute();

  ctx.audit.record(
    { procedure: 'ssh', actor: { kind: 'ssh', name: 'laptop' }, impName: 'dev', startedAt: 990 },
    null,
  );

  await waitFor(() => {
    expect(ctx.logs).not.toBeEmpty();
  });

  expect(ctx.logs).toHaveLength(1);
  expect(ctx.logs[0]).toMatch(/^impd: audit: ssh: .*api_audit/);
});
