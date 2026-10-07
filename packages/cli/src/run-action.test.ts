import { expect, test } from 'bun:test';
import { ORPCError } from '@orpc/client';
import { formatError, formatUnauthorized } from './run-action';

test('#formatError lists the validation issues of a BAD_REQUEST', () => {
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

test('#formatError prints a BAD_REQUEST without issues as its code and message', () => {
  const error = new ORPCError('BAD_REQUEST', { message: 'bad name', data: { reason: 'x' } });

  expect(formatError(error)).toBe('BAD_REQUEST: bad name');
});

test('#formatError prints the code and message of another impd error', () => {
  const error = new ORPCError('CONFLICT', { message: 'imp box already exists' });

  expect(formatError(error)).toBe('CONFLICT: imp box already exists');
});

test('#formatError prints the token hint for a 401 when no saved host was used', () => {
  const error = new ORPCError('UNAUTHORIZED', { status: 401 });

  expect(formatError(error)).toBe(
    'unauthorized: set IMP_TOKEN to the token from <IMP_DATA_DIR>/token, or run imp login <url>',
  );
});

test('#formatError names the saved host to log in to again for a 401', () => {
  const error = new ORPCError('UNAUTHORIZED', { status: 401 });

  expect(
    formatError(error, { host: 'work', url: 'https://imp.example.com', token: 'secret' }),
  ).toBe(
    'unauthorized: work (https://imp.example.com) refused the token; run imp login https://imp.example.com --name work',
  );
});

test('#formatError prints the message of a plain error', () => {
  expect(formatError(new Error('no such imp'))).toBe('no such imp');
});

test('#formatError prints a thrown value that is no error as text', () => {
  expect(formatError('stopped')).toBe('stopped');
});

test('#formatUnauthorized prints the token hint when there is no config', () => {
  expect(formatUnauthorized(null)).toBe(
    'unauthorized: set IMP_TOKEN to the token from <IMP_DATA_DIR>/token, or run imp login <url>',
  );
});

test('#formatUnauthorized prints the token hint for a config from IMP_URL', () => {
  expect(formatUnauthorized({ host: null, url: 'http://127.0.0.1:7070', token: 'secret' })).toBe(
    'unauthorized: set IMP_TOKEN to the token from <IMP_DATA_DIR>/token, or run imp login <url>',
  );
});
