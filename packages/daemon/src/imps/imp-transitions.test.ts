import { expect, test } from 'bun:test';
import { ORPCError } from '@orpc/server';
import { canTransition, findStatesLeadingTo, requireTransition } from './imp-transitions';

test('it allows the M3 lifecycle', () => {
  expect(canTransition('creating', 'running')).toBe(true);
  expect(canTransition('running', 'stopped')).toBe(true);
  expect(canTransition('stopped', 'running')).toBe(true);
  expect(canTransition('error', 'running')).toBe(true);
  expect(canTransition('creating', 'error')).toBe(true);
});

test('it reserves sleep and wake transitions', () => {
  expect(canTransition('running', 'sleeping')).toBe(true);
  expect(canTransition('sleeping', 'running')).toBe(true);
  expect(canTransition('stopped', 'sleeping')).toBe(false);
});

test('it refuses transitions outside the table', () => {
  expect(canTransition('creating', 'stopped')).toBe(false);
  expect(canTransition('running', 'running')).toBe(false);
  expect(canTransition('error', 'sleeping')).toBe(false);
});

test('it names the states that lead to a target', () => {
  expect(findStatesLeadingTo('running')).toEqual(['creating', 'sleeping', 'stopped', 'error']);
  expect(findStatesLeadingTo('stopped')).toEqual(['running', 'sleeping', 'error']);
});

test('it throws INVALID_STATE with the allowed states', () => {
  let caught: unknown;

  try {
    requireTransition('creating', 'stopped', 'stop');
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ORPCError);

  expect(caught).toMatchObject({
    code: 'INVALID_STATE',
    status: 409,
    data: { state: 'creating', allowed: ['running', 'sleeping', 'error'] },
  });
});
