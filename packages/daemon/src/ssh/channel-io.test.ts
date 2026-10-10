import { expect, test } from 'bun:test';
import { ORPCError } from '@orpc/server';
import { AgentError } from '../agent-client/agent-connection';
import { formatFailure } from './channel-io';

test('it formats an agent error as its code and detail', () => {
  expect(formatFailure(new AgentError('DIAL_FAILED', 'connection refused'))).toBe(
    'DIAL_FAILED: connection refused',
  );
});

test('it formats an API error as its code and message', () => {
  expect(formatFailure(new ORPCError('NOT_FOUND', { message: 'no imp named box' }))).toBe(
    'NOT_FOUND: no imp named box',
  );
});

test('it formats any other error as its message', () => {
  expect(formatFailure(new Error('socket hang up'))).toBe('socket hang up');
});
