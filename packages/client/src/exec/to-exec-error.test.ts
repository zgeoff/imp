import { expect, test } from 'bun:test';
import { EXEC_CLOSE_RESTARTING } from '@imp/api';
import { ExecError } from './exec-error';
import { InvalidResumeError } from './invalid-resume-error';
import { InvalidStateError } from './invalid-state-error';
import { NoSessionError } from './no-session-error';
import { toExecError } from './to-exec-error';

test('it keeps the code, message and data of a refusal impd sent', () => {
  const error = toExecError({
    kind: 'failed',
    code: 'RAM_BUDGET_EXCEEDED',
    message: 'no room',
    data: { budgetMib: 1024, usedMib: 900, requestedMib: 512 },
  });

  expect(error).toBeInstanceOf(ExecError);

  expect(error).toMatchObject({
    name: 'ExecError',
    code: 'RAM_BUDGET_EXCEEDED',
    message: 'no room',
    data: { budgetMib: 1024, usedMib: 900, requestedMib: 512 },
  });
});

test('it names a refusal without a code EXEC_ERROR', () => {
  expect(toExecError({ kind: 'failed', code: null, message: 'nothing started' })).toMatchObject({
    code: 'EXEC_ERROR',
    message: 'nothing started',
    data: undefined,
  });
});

test('it makes a NO_SESSION refusal a NoSessionError with its data', () => {
  const data = { bootId: 'boot-2', coldBoots: [] };
  const error = toExecError({ kind: 'failed', code: 'NO_SESSION', message: 'gone', data });

  expect(error).toBeInstanceOf(NoSessionError);
  expect(error).toMatchObject({ name: 'NoSessionError', code: 'NO_SESSION', data });
});

test('it makes a NO_SESSION refusal whose data does not parse a NoSessionError without data', () => {
  const error = toExecError({
    kind: 'failed',
    code: 'NO_SESSION',
    message: 'gone',
    data: { bootId: 7 },
  });

  expect(error).toBeInstanceOf(NoSessionError);
  expect(error).toMatchObject({ code: 'NO_SESSION', data: undefined });
});

test('it makes an INVALID_STATE refusal an InvalidStateError with its data', () => {
  const data = { state: 'sleeping', allowed: ['running'] };
  const error = toExecError({ kind: 'failed', code: 'INVALID_STATE', message: 'asleep', data });

  expect(error).toBeInstanceOf(InvalidStateError);
  expect(error).toMatchObject({ name: 'InvalidStateError', code: 'INVALID_STATE', data });
});

test('it leaves an INVALID_STATE refusal whose data does not parse a plain ExecError', () => {
  const error = toExecError({
    kind: 'failed',
    code: 'INVALID_STATE',
    message: 'asleep',
    data: { state: 'dozing' },
  });

  expect(error).not.toBeInstanceOf(InvalidStateError);

  expect(error).toMatchObject({
    name: 'ExecError',
    code: 'INVALID_STATE',
    data: { state: 'dozing' },
  });
});

test('it makes an INVALID_RESUME refusal an InvalidResumeError with its data', () => {
  const data = { end: 100, bufferStart: 0 };
  const error = toExecError({ kind: 'failed', code: 'INVALID_RESUME', message: 'past', data });

  expect(error).toBeInstanceOf(InvalidResumeError);
  expect(error).toMatchObject({ name: 'InvalidResumeError', code: 'INVALID_RESUME', data });
});

test('it leaves an INVALID_RESUME refusal whose data does not parse a plain ExecError', () => {
  const error = toExecError({
    kind: 'failed',
    code: 'INVALID_RESUME',
    message: 'past',
    data: { end: -1 },
  });

  expect(error).not.toBeInstanceOf(InvalidResumeError);
  expect(error).toMatchObject({ name: 'ExecError', code: 'INVALID_RESUME', data: { end: -1 } });
});

test('it names the exec ticket for a ticket impd refused', () => {
  expect(toExecError({ kind: 'unauthorized', ticketRefused: true })).toMatchObject({
    code: 'UNAUTHORIZED',
    message: 'impd refused the exec ticket: it expired (30 s) or was used already',
  });
});

test('it names the token for a token impd rejected', () => {
  expect(toExecError({ kind: 'unauthorized' })).toMatchObject({
    code: 'UNAUTHORIZED',
    message: 'impd rejected the token',
  });
});

test('it makes an impd it could not reach UNREACHABLE with why', () => {
  expect(toExecError({ kind: 'unreachable', detail: 'connection refused' })).toMatchObject({
    code: 'UNREACHABLE',
    message: 'cannot reach impd (connection refused)',
  });
});

test('it makes a detach DETACHED with its reason and offset', () => {
  expect(toExecError({ kind: 'detached', reason: 'slow', offset: 95 })).toMatchObject({
    code: 'DETACHED',
    message: 'detached from the session (slow)',
    data: { reason: 'slow', offset: 95 },
  });
});

test('it makes a detach without offsets DETACHED with its reason alone', () => {
  expect(toExecError({ kind: 'detached', reason: 'taken_over' }).data).toStrictEqual({
    reason: 'taken_over',
  });
});

test('it makes a connection impd closed for a restart RESTARTING', () => {
  expect(
    toExecError({ kind: 'closed', reason: 'impd is restarting', closeCode: EXEC_CLOSE_RESTARTING }),
  ).toMatchObject({ code: 'RESTARTING', message: 'impd is restarting' });
});

test('it makes a connection that dropped CONNECTION_CLOSED with why', () => {
  expect(toExecError({ kind: 'closed', reason: 'socket hang up', closeCode: 1006 })).toMatchObject({
    code: 'CONNECTION_CLOSED',
    message: 'exec connection closed (socket hang up)',
  });
});

test('it makes a message it cannot read BAD_MESSAGE with what it was', () => {
  expect(toExecError({ kind: 'bad_message', detail: 'unknown message: {}' })).toMatchObject({
    code: 'BAD_MESSAGE',
    message: 'bad message from impd: unknown message: {}',
  });
});

test('it makes a handler that threw LOCAL_ERROR with the throw as its cause', () => {
  const thrown = new Error('EPIPE');

  expect(toExecError({ kind: 'local_error', error: thrown })).toMatchObject({
    code: 'LOCAL_ERROR',
    message: 'an output handler threw',
    cause: thrown,
  });
});
