import { expect, test } from 'bun:test';
import { formatScopeList, isGrantPattern, isPatternsWithin, readLowerScope } from './grant-limits';

test.each([['*'], ['dev'], ['dev-*'], ['a1-b2']])('#isGrantPattern accepts %p', (pattern) => {
  expect(isGrantPattern(pattern)).toBeTrue();
});

test.each([
  ['', 'empty'],
  ['Dev', 'upper case'],
  ['*dev', 'a leading *'],
  ['d*v', 'an inner *'],
  ['dev-**', 'two *'],
  ['1dev', 'a leading digit'],
  [`a${'b'.repeat(31)}`, 'too long'],
])('#isGrantPattern refuses %p, which has %s', (pattern) => {
  expect(isGrantPattern(pattern)).toBeFalse();
});

test.each([
  [['dev-1'], ['dev-*']],
  [['dev-a*'], ['dev-*']],
  [['dev-*'], ['dev-*']],
  [['web'], ['web', 'dev-*']],
  [['*'], ['*']],
  [['dev-1'], ['*']],
  [[], ['dev-*']],
  [null, null],
  [['anything'], null],
])('#isPatternsWithin keeps grant patterns %p within token patterns %p', (grant, token) => {
  expect(isPatternsWithin(grant, token)).toBeTrue();
});

test.each([
  [['dev*'], ['dev-*']],
  [['web'], ['dev-*']],
  [['dev-1', 'web'], ['dev-*']],
  [['*'], ['dev-*']],
  [null, ['*']],
  [['dev-1'], ['d*v-1']],
])('#isPatternsWithin refuses grant patterns %p past token patterns %p', (grant, token) => {
  expect(isPatternsWithin(grant, token)).toBeFalse();
});

test.each([
  ['manage', 'exec', 'exec'],
  ['exec', 'manage', 'exec'],
  ['read', 'manage', 'read'],
  ['exec', 'exec', 'exec'],
] as const)('#readLowerScope reads %s and %s as %s', (a, b, lower) => {
  expect(readLowerScope(a, b)).toBe(lower);
});

test.each([
  ['read', 'read'],
  ['exec', 'read exec'],
  ['manage', 'read exec manage'],
] as const)('#formatScopeList lists %s as %p', (scope, list) => {
  expect(formatScopeList(scope)).toBe(list);
});
