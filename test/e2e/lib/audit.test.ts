import { expect, test } from 'bun:test';
import { parseAuditCalls } from './audit';

test('#parseAuditCalls reads a call by a token and a login over ssh', () => {
  const stdout = JSON.stringify([
    {
      procedure: 'imps.stop',
      actor: 'token',
      actorName: 'e2e-tok-dev-exec',
      outcome: 'FORBIDDEN',
      at: '2026-10-10T04:00:00.000Z',
    },
    { procedure: 'ssh.login', actor: 'root', outcome: 'ok' },
  ]);

  expect(parseAuditCalls(stdout)).toStrictEqual([
    {
      procedure: 'imps.stop',
      actor: 'token',
      actorName: 'e2e-tok-dev-exec',
      outcome: 'FORBIDDEN',
    },
    { procedure: 'ssh.login', actor: 'root', outcome: 'ok' },
  ]);
});

test('#parseAuditCalls rejects a call without an outcome', () => {
  expect(() =>
    parseAuditCalls(JSON.stringify([{ procedure: 'imps.stop', actor: 'token' }])),
  ).toThrow();
});
