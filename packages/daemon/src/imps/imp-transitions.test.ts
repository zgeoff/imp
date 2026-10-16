import { expect, test } from 'bun:test';
import type { ImpState } from '@impz/api';
import { ORPCError } from '@orpc/server';
import { canTransition, findStatesLeadingTo, requireTransition } from './imp-transitions';

test.each<[ImpState, ImpState]>([
  ['creating', 'running'],
  ['creating', 'stopped'],
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
  ['creating', 'sleeping'],
  ['running', 'running'],
  ['stopped', 'sleeping'],
  ['error', 'sleeping'],
])('#canTransition refuses %s to %s', (from, to) => {
  expect(canTransition(from, to)).toBeFalse();
});

// a caller's cast lets any string through, so the table must refuse it
test.each<[string, string, string]>([
  ['constructor', 'name', 'Object'],
  ['__proto__', 'constructor', 'any'],
  ['running', 'constructor', 'any'],
  ['running', '__proto__', 'any'],
  ['hibernating', 'running', 'any'],
  ['running', 'hibernating', 'any'],
  ['running', 'sleeping', 'teleport'],
  ['running', 'sleeping', 'constructor'],
])('#canTransition refuses the unknown move %s to %s via %s', (from, to, via) => {
  const canTransitionAny = canTransition as (from: string, to: string, via: string) => boolean;

  expect(canTransitionAny(from, to, via)).toBeFalse();
});

test('#canTransition allows a warm move stopped to sleeping', () => {
  expect(canTransition('stopped', 'sleeping', 'warm move')).toBeTrue();
});

test('#canTransition allows a warm move every edge open to any action', () => {
  expect(canTransition('running', 'sleeping', 'warm move')).toBeTrue();
});

test.each<[ImpState]>([['creating'], ['error']])(
  '#canTransition refuses a warm move %s to sleeping',
  (from) => {
    expect(canTransition(from, 'sleeping', 'warm move')).toBeFalse();
  },
);

test('#findStatesLeadingTo names only running for a sleep', () => {
  expect(findStatesLeadingTo('sleeping')).toStrictEqual(['running']);
});

test('#findStatesLeadingTo names running and stopped for a warm move to sleeping', () => {
  expect(findStatesLeadingTo('sleeping', 'warm move')).toStrictEqual(['running', 'stopped']);
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
  expect(findStatesLeadingTo('stopped')).toStrictEqual([
    'creating',
    'running',
    'sleeping',
    'error',
  ]);
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
    requireTransition('stopped', 'sleeping', 'sleep');
  });

  expect(refusal).rejects.toStrictEqual(
    new ORPCError('INVALID_STATE', {
      status: 409,
      message: 'cannot sleep an imp that is stopped (allowed: running)',
      data: { state: 'stopped', allowed: ['running'] },
    }),
  );
});
