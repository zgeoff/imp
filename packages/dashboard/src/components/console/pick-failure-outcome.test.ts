import { expect, test } from 'bun:test';
import { ORPCError } from '@zgeoff/imp-client';
import { pickFailureOutcome } from './pick-failure-outcome';

const unauthorized = new ORPCError('UNAUTHORIZED', { status: 401 });

test('an ended session sends the console to the login page', () => {
  expect(pickFailureOutcome(unauthorized, false)).toEqual({ kind: 'login' });
});

test('an unmounted console neither redirects nor shows anything', () => {
  expect(pickFailureOutcome(unauthorized, true)).toEqual({ kind: 'ignore' });
  expect(pickFailureOutcome(new Error('boom'), true)).toEqual({ kind: 'ignore' });
});

test('any other failure is shown', () => {
  const notFound = new ORPCError('NOT_FOUND', { message: 'there is no imp named web' });

  expect(pickFailureOutcome(notFound, false)).toEqual({
    kind: 'show',
    message: 'there is no imp named web',
  });
});
