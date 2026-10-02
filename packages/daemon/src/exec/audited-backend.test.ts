import { expect, test } from 'bun:test';
import type { AuditedCall } from '../audit/api-audit';
import { buildAuditedBackend } from './audited-backend';
import type { ExecBackend } from './exec-session';

test('a terminal exec is audited as a console, a plain one as an exec, a tar tool as cp', async () => {
  const calls: [AuditedCall, unknown][] = [];

  const backend: ExecBackend = {
    openExec: () => Promise.reject(new Error('dev is stopped')),
    openAttach: () => Promise.reject(new Error('no such session')),
    recordActivity: () => Promise.resolve(),
  };

  const audited = buildAuditedBackend(
    backend,
    {
      record: (call, failure) => {
        calls.push([call, failure]);
      },
    },
    { kind: 'dashboard', name: 'laptop' },
    () => 5,
  );

  const opens = [
    audited.openExec('dev', { argv: ['bash'], tty: true }),
    audited.openExec('dev', { argv: ['ls'], tty: false }),
    audited.openExec('dev', { argv: ['imp-agent', 'tar'], tty: false }, 'cp'),
    audited.openAttach('dev', { session: 's1' }),
  ];

  const failures = await Promise.allSettled(opens);

  expect(failures.map((failure) => failure.status)).toEqual([
    'rejected',
    'rejected',
    'rejected',
    'rejected',
  ]);

  expect(
    calls.map(([call, failure]) => [
      call.procedure,
      call.actor.kind,
      call.impName,
      failure !== null,
    ]),
  ).toEqual([
    ['console', 'dashboard', 'dev', true],
    ['exec', 'dashboard', 'dev', true],
    ['cp', 'dashboard', 'dev', true],
    ['attach', 'dashboard', 'dev', true],
  ]);
});
