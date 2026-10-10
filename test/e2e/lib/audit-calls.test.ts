import { expect, test } from 'bun:test';
import { parseAuditCalls, pickNewCalls } from './audit-calls';

test('#parseAuditCalls reads each row’s time, procedure and actor', () => {
  const json = JSON.stringify([
    { at: '2026-10-10T08:00:01.000Z', procedure: 'imps.create', actor: 'token', id: 7 },
  ]);

  expect(parseAuditCalls(json)).toStrictEqual([
    { at: '2026-10-10T08:00:01.000Z', procedure: 'imps.create', actor: 'token' },
  ]);
});

test('#pickNewCalls keeps the rows added ahead of the earlier ones', () => {
  const before = [{ at: '2026-10-09T08:00:00.000Z', procedure: 'imps.create', actor: 'token' }];

  const after = [
    { at: '2026-10-10T08:00:02.000Z', procedure: 'imps.destroy', actor: 'token' },
    { at: '2026-10-10T08:00:01.000Z', procedure: 'imps.create', actor: 'token' },
    ...before,
  ];

  expect(pickNewCalls(after, before)).toStrictEqual([
    { at: '2026-10-10T08:00:02.000Z', procedure: 'imps.destroy', actor: 'token' },
    { at: '2026-10-10T08:00:01.000Z', procedure: 'imps.create', actor: 'token' },
  ]);
});

test('#pickNewCalls throws when the earlier rows changed', () => {
  const before = [{ at: '2026-10-09T08:00:00.000Z', procedure: 'imps.create', actor: 'token' }];

  expect(() =>
    pickNewCalls(
      [{ at: '2026-10-10T08:00:01.000Z', procedure: 'imps.wake', actor: 'token' }],
      before,
    ),
  ).toThrowWithMessage(Error, /^the audit rows from before changed: /);
});
