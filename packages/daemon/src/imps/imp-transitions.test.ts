import { expect, test } from 'bun:test';
import type { ImpState } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { canTransition, findStatesLeadingTo, requireTransition } from './imp-transitions';

test.each<[ImpState, ImpState]>([
  ['creating', 'running'],
  ['creating', 'error'],
  ['running', 'stopped'],
  ['running', 'sleeping'],
  ['running', 'error'],
  ['sleeping', 'running'],
  ['sleeping', 'stopped'],
  ['sleeping', 'error'],
  ['stopped', 'running'],
  ['stopped', 'error'],
  ['error', 'running'],
  ['error', 'stopped'],
])('#canTransition allows %s to %s', (from, to) => {
  expect(canTransition(from, to)).toBeTrue();
});

test.each<[ImpState, ImpState]>([
  ['creating', 'stopped'],
  ['creating', 'sleeping'],
  ['running', 'running'],
  ['stopped', 'sleeping'],
  ['error', 'sleeping'],
])('#canTransition refuses %s to %s', (from, to) => {
  expect(canTransition(from, to)).toBeFalse();
});

test('#findStatesLeadingTo names every state that can reach running', () => {
  expect(findStatesLeadingTo('running')).toStrictEqual([
    'creating',
    'sleeping',
    'stopped',
    'error',
  ]);
});

test('#findStatesLeadingTo names every state that can reach stopped', () => {
  expect(findStatesLeadingTo('stopped')).toStrictEqual(['running', 'sleeping', 'error']);
});

test('#findStatesLeadingTo names no state for creating', () => {
  expect(findStatesLeadingTo('creating')).toBeEmpty();
});

test('#requireTransition passes an allowed transition', () => {
  expect(() => {
    requireTransition('running', 'stopped', 'stop');
  }).not.toThrow();
});

test('#requireTransition throws INVALID_STATE with the states that lead to the target', () => {
  const refusal = Promise.try(() => {
    requireTransition('creating', 'stopped', 'stop');
  });

  expect(refusal).rejects.toStrictEqual(
    new ORPCError('INVALID_STATE', {
      status: 409,
      message: 'cannot stop an imp that is creating (allowed: running, sleeping, error)',
      data: { state: 'creating', allowed: ['running', 'sleeping', 'error'] },
    }),
  );
});
