import { expect, test } from 'bun:test';
import { formatScopeList, isGrantPattern, isPatternsWithin, readLowerScope } from './grant-limits';

test('a grant pattern is an imp name, a name prefix and a trailing *, or *', () => {
  for (const pattern of ['*', 'dev', 'dev-*', 'a1-b2']) {
    expect(isGrantPattern(pattern)).toBeTrue();
  }

  for (const pattern of ['', 'Dev', '*dev', 'd*v', 'dev-**', '1dev', `a${'b'.repeat(31)}`]) {
    expect(isGrantPattern(pattern)).toBeFalse();
  }
});

test('a grant stays within its token’s patterns', () => {
  expect(isPatternsWithin(['dev-1'], ['dev-*'])).toBeTrue();
  expect(isPatternsWithin(['dev-a*'], ['dev-*'])).toBeTrue();
  expect(isPatternsWithin(['dev-*'], ['dev-*'])).toBeTrue();
  expect(isPatternsWithin(['web'], ['web', 'dev-*'])).toBeTrue();
  expect(isPatternsWithin(['*'], ['*'])).toBeTrue();
  expect(isPatternsWithin(['dev-1'], ['*'])).toBeTrue();
  expect(isPatternsWithin([], ['dev-*'])).toBeTrue();
  expect(isPatternsWithin(null, null)).toBeTrue();
  expect(isPatternsWithin(['anything'], null)).toBeTrue();
});

test('a grant never goes past its token’s patterns', () => {
  expect(isPatternsWithin(['dev*'], ['dev-*'])).toBeFalse();
  expect(isPatternsWithin(['web'], ['dev-*'])).toBeFalse();
  expect(isPatternsWithin(['dev-1', 'web'], ['dev-*'])).toBeFalse();
  expect(isPatternsWithin(['*'], ['dev-*'])).toBeFalse();

  // null is every imp and the host: only a token with null gives it
  expect(isPatternsWithin(null, ['*'])).toBeFalse();

  // a token pattern with * inside covers only itself
  expect(isPatternsWithin(['dev-1'], ['d*v-1'])).toBeFalse();
});

test('the lower scope and the scope list a grant answers with', () => {
  expect(readLowerScope('manage', 'exec')).toBe('exec');
  expect(readLowerScope('read', 'manage')).toBe('read');
  expect(formatScopeList('read')).toBe('read');
  expect(formatScopeList('exec')).toBe('read exec');
  expect(formatScopeList('manage')).toBe('read exec manage');
});
