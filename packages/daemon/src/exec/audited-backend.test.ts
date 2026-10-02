import { expect, test } from 'bun:test';
import type { ImpEvent } from '@imp/api';
import type { AgentExecRequest, ExecEvent, ExecStream } from '../agent-client/exec-stream';
import type { AuditedCall } from '../audit/api-audit';
import { createEventBus } from '../events/event-bus';
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
    createEventBus(),
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

// a stream that ends at once
async function* readNoEvents(): AsyncGenerator<ExecEvent, void, undefined> {}

function buildOuterRequest(argv: readonly string[]): AgentExecRequest {
  return { argv, tty: true, outer: true };
}

test('an exec in the agent is audited as exec-agent, and is an event once the agent took it', async () => {
  const calls: AuditedCall[] = [];
  const events: ImpEvent[] = [];
  const bus = createEventBus();

  bus.subscribe((event) => {
    events.push(event);
  });

  // the stream is never read
  const stream: ExecStream = {
    pid: 7,
    session: null,
    created: false,
    groupKill: false,
    output: null,
    writeStdin: () => {},
    stdinDrained: () => Promise.resolve(),
    closeStdin: () => {},
    resize: () => {},
    sendSignal: () => {},
    events: readNoEvents,
    close: () => {},
  };

  const backend: ExecBackend = {
    openExec: (_name, request) =>
      request.argv[0] === 'refused'
        ? Promise.reject(new Error('AGENT_OUTDATED'))
        : Promise.resolve(stream),
    openAttach: () => Promise.reject(new Error('unused')),
    recordActivity: () => Promise.resolve(),
  };

  const audited = buildAuditedBackend(
    backend,
    {
      record: (call) => {
        calls.push(call);
      },
    },
    { kind: 'token', name: 'admin' },
    bus,
    () => 5,
  );

  await audited.openExec('dev', buildOuterRequest(['sh', '-c', 'secret args']), 'outer-exec');
  await audited.openExec('dev', buildOuterRequest(['refused']), 'outer-exec').catch(() => null);
  await audited.openExec('dev', { argv: ['ls'], tty: false });

  expect(calls.map((call) => call.procedure)).toEqual(['exec-agent', 'exec-agent', 'exec']);

  expect(events).toEqual([
    {
      v: 1,
      at: new Date(5),
      ev: 'AgentExec',
      name: 'dev',
      actor: 'token',
      actorName: 'admin',
      tty: true,
      command: 'sh',
    },
  ]);
});
