import { expect, test } from 'bun:test';
import { ORPCError } from '@orpc/client';
import { formatError } from './run-action';

test('it lists the validation issues of a BAD_REQUEST', () => {
  const error = new ORPCError('BAD_REQUEST', {
    message: 'Input validation failed',
    data: {
      issues: [
        { message: 'Invalid input: expected number, received NaN', path: ['memoryMib'] },
        { message: 'Too small', path: [{ key: 'name' }] },
        { message: 'Bad object' },
      ],
    },
  });

  expect(formatError(error)).toBe(
    'BAD_REQUEST: Input validation failed (memoryMib: Invalid input: expected number, received NaN; name: Too small; Bad object)',
  );
});

test('it prints the code and message of other errors, and the token hint on a 401', () => {
  const conflict = new ORPCError('CONFLICT', { message: 'imp box already exists' });
  const unauthorized = new ORPCError('UNAUTHORIZED', { status: 401 });

  expect(formatError(conflict)).toBe('CONFLICT: imp box already exists');
  expect(formatError(unauthorized)).toStartWith('unauthorized: set IMP_TOKEN');
});
