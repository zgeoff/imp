import { expect, test } from 'bun:test';
import { isImpAllowed } from './imp-patterns';

test.each([
  [null, 'anything', true],
  [['dev-*'], 'dev-a', true],
  [['dev-*'], 'dev-', true],
  [['dev-*'], 'prod-dev-a', false],
  [['*-ci'], 'build-ci', true],
  [['a*b*c'], 'abc', true],
  [['a*b*c'], 'axxbyyc', true],
  [['a*b*c'], 'acb', false],
  [['ab*ba'], 'aba', false],
  [['exact'], 'exact', true],
  [['exact'], 'exactly', false],
  [['one', 'two-*'], 'two-x', true],
  [['*'], 'x', true],
])('it answers patterns %p for imp %p with %p', (patterns, name, allowed) => {
  expect(isImpAllowed(patterns, name)).toBe(allowed);
});
