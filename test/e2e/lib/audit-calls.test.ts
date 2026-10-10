import { expect, test } from 'bun:test';
import { parseAuditCalls, pickNewCalls } from './audit-calls';

test('#parseAuditCalls reads each row’s time, procedure, actor, outcome and duration', () => {
  const json = JSON.stringify([
    {
      at: '2026-10-10T08:00:01.000Z',
      procedure: 'imps.create',
      actor: 'token',
      actorName: 'root',
      imp: 'e2e-life-ev',
      outcome: 'ok',
      durationMs: 812,
    },
  ]);

  expect(parseAuditCalls(json)).toStrictEqual([
    {
      at: '2026-10-10T08:00:01.000Z',
      procedure: 'imps.create',
      actor: 'token',
      outcome: 'ok',
      durationMs: 812,
    },
  ]);
});

test('#pickNewCalls keeps the rows added ahead of the earlier ones', () => {
  const before = [
    {
      at: '2026-10-09T08:00:00.000Z',
      procedure: 'imps.create',
      actor: 'token',
      outcome: 'ok',
      durationMs: 900,
    },
  ];

  const after = [
    {
      at: '2026-10-10T08:00:02.000Z',
      procedure: 'imps.destroy',
      actor: 'token',
      outcome: 'ok',
      durationMs: 40,
    },
    {
      at: '2026-10-10T08:00:01.000Z',
      procedure: 'imps.create',
      actor: 'token',
      outcome: 'ok',
      durationMs: 800,
    },
    ...before,
  ];

  expect(pickNewCalls(after, before)).toStrictEqual([
    {
      at: '2026-10-10T08:00:02.000Z',
      procedure: 'imps.destroy',
      actor: 'token',
      outcome: 'ok',
      durationMs: 40,
    },
    {
      at: '2026-10-10T08:00:01.000Z',
      procedure: 'imps.create',
      actor: 'token',
      outcome: 'ok',
      durationMs: 800,
    },
  ]);
});

test('#pickNewCalls keeps the new rows when they push earlier rows out of a full window', () => {
  // a full read of 100 rows, one per minute on 9 October
  const before = Array.from({ length: 100 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 9, 9, 8, 100 - index)).toISOString(),
    procedure: 'imps.wake',
    actor: 'token',
    outcome: 'ok',
    durationMs: 30,
  }));

  const after = [
    {
      at: '2026-10-10T08:00:04.000Z',
      procedure: 'imps.destroy',
      actor: 'token',
      outcome: 'ok',
      durationMs: 40,
    },
    {
      at: '2026-10-10T08:00:03.000Z',
      procedure: 'imps.wake',
      actor: 'token',
      outcome: 'ok',
      durationMs: 300,
    },
    {
      at: '2026-10-10T08:00:02.000Z',
      procedure: 'imps.sleep',
      actor: 'token',
      outcome: 'ok',
      durationMs: 200,
    },
    {
      at: '2026-10-10T08:00:01.000Z',
      procedure: 'imps.create',
      actor: 'token',
      outcome: 'ok',
      durationMs: 800,
    },
    ...before.slice(0, 96),
  ];

  expect(pickNewCalls(after, before)).toStrictEqual([
    {
      at: '2026-10-10T08:00:04.000Z',
      procedure: 'imps.destroy',
      actor: 'token',
      outcome: 'ok',
      durationMs: 40,
    },
    {
      at: '2026-10-10T08:00:03.000Z',
      procedure: 'imps.wake',
      actor: 'token',
      outcome: 'ok',
      durationMs: 300,
    },
    {
      at: '2026-10-10T08:00:02.000Z',
      procedure: 'imps.sleep',
      actor: 'token',
      outcome: 'ok',
      durationMs: 200,
    },
    {
      at: '2026-10-10T08:00:01.000Z',
      procedure: 'imps.create',
      actor: 'token',
      outcome: 'ok',
      durationMs: 800,
    },
  ]);
});

test('#pickNewCalls keeps every row when there were none before', () => {
  const after = [
    {
      at: '2026-10-10T08:00:01.000Z',
      procedure: 'imps.create',
      actor: 'token',
      outcome: 'ok',
      durationMs: 800,
    },
  ];

  expect(pickNewCalls(after, [])).toStrictEqual([
    {
      at: '2026-10-10T08:00:01.000Z',
      procedure: 'imps.create',
      actor: 'token',
      outcome: 'ok',
      durationMs: 800,
    },
  ]);
});

test('#pickNewCalls throws when the newest row from before is gone', () => {
  const before = [
    {
      at: '2026-10-09T08:00:00.000Z',
      procedure: 'imps.create',
      actor: 'token',
      outcome: 'ok',
      durationMs: 900,
    },
  ];

  expect(() =>
    pickNewCalls(
      [
        {
          at: '2026-10-10T08:00:01.000Z',
          procedure: 'imps.wake',
          actor: 'token',
          outcome: 'ok',
          durationMs: 300,
        },
      ],
      before,
    ),
  ).toThrowWithMessage(Error, /^the newest audit row from before is gone: /);
});

test('#pickNewCalls throws when an earlier row both reads hold changed', () => {
  const before = [
    {
      at: '2026-10-09T08:00:01.000Z',
      procedure: 'imps.wake',
      actor: 'token',
      outcome: 'ok',
      durationMs: 300,
    },
    {
      at: '2026-10-09T08:00:00.000Z',
      procedure: 'imps.create',
      actor: 'token',
      outcome: 'ok',
      durationMs: 900,
    },
  ];

  expect(() =>
    pickNewCalls(
      [
        {
          at: '2026-10-09T08:00:01.000Z',
          procedure: 'imps.wake',
          actor: 'token',
          outcome: 'ok',
          durationMs: 300,
        },
        {
          at: '2026-10-09T08:00:00.000Z',
          procedure: 'imps.create',
          actor: 'token',
          outcome: 'CONFLICT',
          durationMs: 900,
        },
      ],
      before,
    ),
  ).toThrowWithMessage(Error, /^the audit rows from before changed: /);
});
