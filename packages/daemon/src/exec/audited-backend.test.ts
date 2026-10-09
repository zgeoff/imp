import { expect, mock, test } from 'bun:test';
import type { ImpEvent } from '@imp/api';
import type { ApiAudit } from '../audit/api-audit';
import { createEventBus } from '../events/event-bus';
import { buildStubAgentExecStream } from '../test-utils/build-stub-agent-exec-stream';
import { buildStubExecBackend } from '../test-utils/build-stub-exec-backend';
import { buildAuditedBackend } from './audited-backend';

test('it audits a terminal exec as a console, with what it failed with', () => {
  const failure = new Error('dev is stopped');

  const stub = buildStubExecBackend({ exec: failure });
  const record = mock<ApiAudit['record']>();

  const audited = buildAuditedBackend(
    stub.backend,
    { record },
    { kind: 'dashboard', name: 'laptop' },
    createEventBus(),
    () => 5,
  );

  expect(audited.openExec('dev', { argv: ['bash'], tty: true })).rejects.toBe(failure);

  expect(record).toHaveBeenCalledExactlyOnceWith(
    {
      procedure: 'console',
      actor: { kind: 'dashboard', name: 'laptop' },
      impName: 'dev',
      startedAt: 5,
    },
    failure,
  );
});

test('it audits a plain exec as an exec, with no failure once it opens', async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const record = mock<ApiAudit['record']>();

  const audited = buildAuditedBackend(
    stub.backend,
    { record },
    { kind: 'dashboard', name: 'laptop' },
    createEventBus(),
    () => 5,
  );

  await audited.openExec('dev', { argv: ['ls'], tty: false });

  expect(record).toHaveBeenCalledExactlyOnceWith(
    {
      procedure: 'exec',
      actor: { kind: 'dashboard', name: 'laptop' },
      impName: 'dev',
      startedAt: 5,
    },
    null,
  );
});

test('it audits the tar tool as cp', async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const record = mock<ApiAudit['record']>();

  const audited = buildAuditedBackend(
    stub.backend,
    { record },
    { kind: 'dashboard', name: 'laptop' },
    createEventBus(),
    () => 5,
  );

  await audited.openExec('dev', { argv: ['imp-agent', 'tar'], tty: false }, 'cp');

  expect(record).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ procedure: 'cp' }),
    null,
  );
});

test('it audits an attach as an attach', () => {
  const failure = new Error('no such session');

  const stub = buildStubExecBackend({ attach: failure });
  const record = mock<ApiAudit['record']>();

  const audited = buildAuditedBackend(
    stub.backend,
    { record },
    { kind: 'dashboard', name: 'laptop' },
    createEventBus(),
    () => 5,
  );

  expect(audited.openAttach('dev', { session: 's1' })).rejects.toBe(failure);

  expect(record).toHaveBeenCalledExactlyOnceWith(
    {
      procedure: 'attach',
      actor: { kind: 'dashboard', name: 'laptop' },
      impName: 'dev',
      startedAt: 5,
    },
    failure,
  );
});

test('it audits an exec in the agent as exec-agent', async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const record = mock<ApiAudit['record']>();

  const audited = buildAuditedBackend(
    stub.backend,
    { record },
    { kind: 'token', name: 'admin' },
    createEventBus(),
    () => 5,
  );

  await audited.openExec('dev', { argv: ['sh'], tty: true, outer: true }, 'outer-exec');

  expect(record).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ procedure: 'exec-agent' }),
    null,
  );
});

test('it publishes an exec in the agent once the agent took it, naming only the command', async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const bus = createEventBus();
  const events: ImpEvent[] = [];

  bus.subscribe((event) => {
    events.push(event);
  });

  const audited = buildAuditedBackend(
    stub.backend,
    { record: mock<ApiAudit['record']>() },
    { kind: 'token', name: 'admin' },
    bus,
    () => 5,
  );

  await audited.openExec(
    'dev',
    { argv: ['sh', '-c', 'secret args'], tty: true, outer: true },
    'outer-exec',
  );

  expect(events).toStrictEqual([
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

test('it publishes nothing for an exec in the agent that the agent refused', () => {
  const failure = new Error('AGENT_OUTDATED');

  const stub = buildStubExecBackend({ exec: failure });
  const bus = createEventBus();
  const events: ImpEvent[] = [];

  bus.subscribe((event) => {
    events.push(event);
  });

  const audited = buildAuditedBackend(
    stub.backend,
    { record: mock<ApiAudit['record']>() },
    { kind: 'token', name: 'admin' },
    bus,
    () => 5,
  );

  expect(
    audited.openExec('dev', { argv: ['sh'], tty: true, outer: true }, 'outer-exec'),
  ).rejects.toBe(failure);

  expect(events).toStrictEqual([]);
});

test('it publishes nothing for a plain exec', async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const bus = createEventBus();
  const events: ImpEvent[] = [];

  bus.subscribe((event) => {
    events.push(event);
  });

  const audited = buildAuditedBackend(
    stub.backend,
    { record: mock<ApiAudit['record']>() },
    { kind: 'token', name: 'admin' },
    bus,
    () => 5,
  );

  await audited.openExec('dev', { argv: ['ls'], tty: false });

  expect(events).toStrictEqual([]);
});
