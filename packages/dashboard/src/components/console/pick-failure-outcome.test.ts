import { expect, test } from 'bun:test';
import { ORPCError } from '@zgeoff/imp-client';
import { pickFailureOutcome } from './pick-failure-outcome';

test('it sends the console to the login page when the session ended', () => {
  expect(pickFailureOutcome(new ORPCError('UNAUTHORIZED', { status: 401 }), false)).toStrictEqual({
    kind: 'login',
  });
});

test('it ignores an ended session once the console is unmounted', () => {
  expect(pickFailureOutcome(new ORPCError('UNAUTHORIZED', { status: 401 }), true)).toStrictEqual({
    kind: 'ignore',
  });
});

test('it ignores any other failure once the console is unmounted', () => {
  expect(pickFailureOutcome(new Error('boom'), true)).toStrictEqual({ kind: 'ignore' });
});

test('it shows the message of any other failure', () => {
  const notFound = new ORPCError('NOT_FOUND', { message: 'there is no imp named web' });

  expect(pickFailureOutcome(notFound, false)).toStrictEqual({
    kind: 'show',
    message: 'there is no imp named web',
  });
});

test('it shows the text of a failure that is not an Error', () => {
  expect(pickFailureOutcome('the socket dropped', false)).toStrictEqual({
    kind: 'show',
    message: 'the socket dropped',
  });
});
