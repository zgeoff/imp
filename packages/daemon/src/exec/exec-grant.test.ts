import { expect, test } from 'bun:test';
import { buildRamBudgetError } from '../api-errors';
import { buildMockCaller } from '../test-utils/build-mock-caller';
import { buildStubAgentExecStream } from '../test-utils/build-stub-agent-exec-stream';
import { buildStubExecBackend } from '../test-utils/build-stub-exec-backend';
import { buildGrantedBackend } from './exec-grant';

test('it opens an exec in an imp the token may exec in', async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const granted = buildGrantedBackend(stub.backend, { caller: buildMockCaller(), name: null });

  await expect(granted.openExec('a', { argv: ['true'], tty: false })).toResolve();

  expect(stub.opens).toStrictEqual([
    { kind: 'exec', name: 'a', request: { argv: ['true'], tty: false }, feature: undefined },
  ]);
});

test("it opens an exec in a ticket's own imp", async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const caller = buildMockCaller({ kind: 'dashboard' });
  const granted = buildGrantedBackend(stub.backend, { caller, name: 'a' });

  await expect(granted.openExec('a', { argv: ['true'], tty: false })).toResolve();

  expect(stub.opens).toStrictEqual([
    { kind: 'exec', name: 'a', request: { argv: ['true'], tty: false }, feature: undefined },
  ]);
});

test("it attaches to a session in a ticket's own imp", async () => {
  const stub = buildStubExecBackend({ attach: buildStubAgentExecStream().stream });
  const caller = buildMockCaller({ kind: 'dashboard' });
  const granted = buildGrantedBackend(stub.backend, { caller, name: 'a' });

  await expect(granted.openAttach('a', { session: 'main' })).toResolve();

  expect(stub.opens).toStrictEqual([{ kind: 'attach', name: 'a', request: { session: 'main' } }]);
});

test("it refuses an exec in an imp other than the ticket's", () => {
  const stub = buildStubExecBackend();
  const caller = buildMockCaller({ kind: 'dashboard' });
  const granted = buildGrantedBackend(stub.backend, { caller, name: 'a' });

  expect(granted.openExec('b', { argv: ['true'], tty: false })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'the exec ticket is for imp a',
  });

  expect(stub.opens).toStrictEqual([]);
});

test("it refuses an attach in an imp other than the ticket's", () => {
  const stub = buildStubExecBackend();
  const caller = buildMockCaller({ kind: 'dashboard' });
  const granted = buildGrantedBackend(stub.backend, { caller, name: 'a' });

  expect(granted.openAttach('b', { session: 'main' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'the exec ticket is for imp a',
  });

  expect(stub.opens).toStrictEqual([]);
});

test('it refuses an exec on a socket with no grant', () => {
  const stub = buildStubExecBackend();
  const granted = buildGrantedBackend(stub.backend, undefined);

  expect(granted.openExec('a', { argv: ['true'], tty: false })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'the exec socket was not authorized',
  });

  expect(stub.opens).toStrictEqual([]);
});

test('it refuses an exec for a read token', () => {
  const stub = buildStubExecBackend();
  const caller = buildMockCaller({ scope: 'read' });
  const granted = buildGrantedBackend(stub.backend, { caller, name: null });

  expect(granted.openExec('dev-a', { argv: ['true'], tty: false })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: `token ${caller.name} may not exec in imp dev-a`,
  });

  expect(stub.opens).toStrictEqual([]);
});

test("it refuses an attach outside a patterned token's imps", () => {
  const stub = buildStubExecBackend();
  const caller = buildMockCaller({ scope: 'exec', imps: ['dev-*'] });
  const granted = buildGrantedBackend(stub.backend, { caller, name: null });

  expect(granted.openAttach('prod', { session: 'main' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: `token ${caller.name} may not exec in imp prod`,
  });

  expect(stub.opens).toStrictEqual([]);
});

test("it opens an exec in one of a patterned token's imps", async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const caller = buildMockCaller({ scope: 'exec', imps: ['dev-*'] });
  const granted = buildGrantedBackend(stub.backend, { caller, name: null });

  await expect(granted.openExec('dev-a', { argv: ['true'], tty: false })).toResolve();

  expect(stub.opens).toStrictEqual([
    { kind: 'exec', name: 'dev-a', request: { argv: ['true'], tty: false }, feature: undefined },
  ]);
});

test("it refuses a tool on a ticket's own imp", () => {
  const stub = buildStubExecBackend();
  const caller = buildMockCaller({ kind: 'dashboard' });
  const granted = buildGrantedBackend(stub.backend, { caller, name: 'a' });

  expect(
    granted.openExec(
      'a',
      { argv: ['/run/imp/sys/imp-agent', 'tar', 'create', '/etc'], tty: false, user: 'root' },
      'cp',
    ),
  ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'an exec ticket cannot run a tool' });

  expect(stub.opens).toStrictEqual([]);
});

test('it opens a tool with its feature for a manage token', async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const caller = buildMockCaller({ scope: 'manage' });
  const granted = buildGrantedBackend(stub.backend, { caller, name: null });

  await expect(
    granted.openExec('a', { argv: ['tar'], tty: false, user: 'root' }, 'cp'),
  ).toResolve();

  expect(stub.opens).toStrictEqual([
    {
      kind: 'exec',
      name: 'a',
      request: { argv: ['tar'], tty: false, user: 'root' },
      feature: 'cp',
    },
  ]);
});

test('it refuses a tool for a read token', () => {
  const stub = buildStubExecBackend();
  const caller = buildMockCaller({ scope: 'read' });
  const granted = buildGrantedBackend(stub.backend, { caller, name: null });

  expect(
    granted.openExec('a', { argv: ['tar'], tty: false, user: 'root' }, 'cp'),
  ).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: `token ${caller.name} may not exec in imp a`,
  });

  expect(stub.opens).toStrictEqual([]);
});

test('it refuses a tool for an exec token', () => {
  const stub = buildStubExecBackend();
  const caller = buildMockCaller({ scope: 'exec' });
  const granted = buildGrantedBackend(stub.backend, { caller, name: null });

  expect(
    granted.openExec('a', { argv: ['tar'], tty: false, user: 'root' }, 'cp'),
  ).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: `token ${caller.name} needs scope manage to copy as root`,
  });

  expect(stub.opens).toStrictEqual([]);
});

test("it refuses a tool outside a patterned manage token's imps", () => {
  const stub = buildStubExecBackend();
  const caller = buildMockCaller({ scope: 'manage', imps: ['dev-*'] });
  const granted = buildGrantedBackend(stub.backend, { caller, name: null });

  expect(
    granted.openExec('prod', { argv: ['tar'], tty: false, user: 'root' }, 'cp'),
  ).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: `token ${caller.name} may not exec in imp prod`,
  });

  expect(stub.opens).toStrictEqual([]);
});

test("it opens a tool in one of a patterned manage token's imps", async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const caller = buildMockCaller({ scope: 'manage', imps: ['dev-*'] });
  const granted = buildGrantedBackend(stub.backend, { caller, name: null });

  await expect(
    granted.openExec('dev-a', { argv: ['tar'], tty: false, user: 'root' }, 'cp'),
  ).toResolve();

  expect(stub.opens).toStrictEqual([
    {
      kind: 'exec',
      name: 'dev-a',
      request: { argv: ['tar'], tty: false, user: 'root' },
      feature: 'cp',
    },
  ]);
});

test("it names only the imps the caller may read in an exec's refused boot", () => {
  const stub = buildStubExecBackend({
    exec: buildRamBudgetError({
      budgetMib: 800,
      usedMib: 600,
      requestedMib: 300,
      protected: [
        { name: 'dev-b', ramMib: 300, leased: true, busy: false },
        { name: 'prod', ramMib: 300, leased: false, busy: true },
      ],
    }),
  });

  const caller = buildMockCaller({ scope: 'exec', imps: ['dev-*'] });
  const granted = buildGrantedBackend(stub.backend, { caller, name: null });

  expect(granted.openExec('dev-a', { argv: ['true'], tty: false })).rejects.toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    data: {
      neededMib: 100,
      protected: [{ name: 'dev-b', ramMib: 300, leased: true, busy: false }],
      protectedHidden: 1,
    },
  });
});

test("it names only the imps the caller may read in an attach's refused boot", () => {
  const stub = buildStubExecBackend({
    attach: buildRamBudgetError({
      budgetMib: 800,
      usedMib: 600,
      requestedMib: 300,
      protected: [
        { name: 'dev-b', ramMib: 300, leased: true, busy: false },
        { name: 'prod', ramMib: 300, leased: false, busy: true },
      ],
    }),
  });

  const caller = buildMockCaller({ scope: 'exec', imps: ['dev-*'] });
  const granted = buildGrantedBackend(stub.backend, { caller, name: null });

  expect(granted.openAttach('dev-a', { session: 'main' })).rejects.toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    data: {
      protected: [{ name: 'dev-b', ramMib: 300, leased: true, busy: false }],
      protectedHidden: 1,
    },
  });
});

test('it passes a failure that hides no imps through unchanged', () => {
  const failure = new Error('dev is stopped');

  const stub = buildStubExecBackend({ exec: failure });
  const granted = buildGrantedBackend(stub.backend, { caller: buildMockCaller(), name: null });

  expect(granted.openExec('dev', { argv: ['true'], tty: false })).rejects.toBe(failure);
});

test('it opens an exec in the agent for a host-wide manage token', async () => {
  const stub = buildStubExecBackend({ exec: buildStubAgentExecStream().stream });
  const caller = buildMockCaller({ scope: 'manage' });
  const granted = buildGrantedBackend(stub.backend, { caller, name: null });

  await expect(
    granted.openExec('dev', { argv: ['sh'], tty: true, outer: true }, 'outer-exec'),
  ).toResolve();

  expect(stub.opens).toStrictEqual([
    {
      kind: 'exec',
      name: 'dev',
      request: { argv: ['sh'], tty: true, outer: true },
      feature: 'outer-exec',
    },
  ]);
});

test('it refuses an exec in the agent for an exec token', () => {
  const stub = buildStubExecBackend();
  const caller = buildMockCaller({ scope: 'exec' });
  const granted = buildGrantedBackend(stub.backend, { caller, name: null });

  expect(
    granted.openExec('dev', { argv: ['sh'], tty: true, outer: true }, 'outer-exec'),
  ).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: `token ${caller.name} needs host-wide scope manage to exec in the agent`,
  });

  expect(stub.opens).toStrictEqual([]);
});

test('it refuses an exec in the agent for a manage token limited to some imps', () => {
  const stub = buildStubExecBackend();
  const caller = buildMockCaller({ scope: 'manage', imps: ['dev'] });
  const granted = buildGrantedBackend(stub.backend, { caller, name: null });

  expect(
    granted.openExec('dev', { argv: ['sh'], tty: true, outer: true }, 'outer-exec'),
  ).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: `token ${caller.name} needs host-wide scope manage to exec in the agent`,
  });

  expect(stub.opens).toStrictEqual([]);
});

test("it refuses an exec in the agent on a ticket's own imp", () => {
  const stub = buildStubExecBackend();
  const caller = buildMockCaller({ kind: 'dashboard', scope: 'manage' });
  const granted = buildGrantedBackend(stub.backend, { caller, name: 'dev' });

  expect(
    granted.openExec('dev', { argv: ['sh'], tty: true, outer: true }, 'outer-exec'),
  ).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'an exec ticket cannot run an exec in the agent',
  });

  expect(stub.opens).toStrictEqual([]);
});

test('it refuses an exec in the agent on a socket with no grant', () => {
  const stub = buildStubExecBackend();
  const granted = buildGrantedBackend(stub.backend, undefined);

  expect(
    granted.openExec('dev', { argv: ['sh'], tty: true, outer: true }, 'outer-exec'),
  ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'the exec socket was not authorized' });

  expect(stub.opens).toStrictEqual([]);
});
