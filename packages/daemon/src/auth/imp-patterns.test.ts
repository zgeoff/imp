import { expect, test } from 'bun:test';
import fc from 'fast-check';
import { isImpAllowed, toLikePattern } from './imp-patterns';

test('null patterns allow every imp', () => {
  expect(isImpAllowed(null, 'anything')).toBeTrue();
});

test('a pattern is a name with * for any run of characters', () => {
  expect(isImpAllowed(['dev-*'], 'dev-a')).toBeTrue();
  expect(isImpAllowed(['dev-*'], 'dev-')).toBeTrue();
  expect(isImpAllowed(['dev-*'], 'prod-dev-a')).toBeFalse();
  expect(isImpAllowed(['*-ci'], 'build-ci')).toBeTrue();
  expect(isImpAllowed(['a*b*c'], 'abc')).toBeTrue();
  expect(isImpAllowed(['a*b*c'], 'axxbyyc')).toBeTrue();
  expect(isImpAllowed(['a*b*c'], 'acb')).toBeFalse();
  expect(isImpAllowed(['ab*ba'], 'aba')).toBeFalse();
  expect(isImpAllowed(['exact'], 'exact')).toBeTrue();
  expect(isImpAllowed(['exact'], 'exactly')).toBeFalse();
  expect(isImpAllowed(['one', 'two-*'], 'two-x')).toBeTrue();
  expect(isImpAllowed(['*'], 'x')).toBeTrue();
});

test('the matcher agrees with the LIKE pattern the audit queries use', () => {
  const name = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/);
  const pattern = fc.stringMatching(/^[a-z*][a-z0-9*-]{0,6}$/);

  fc.assert(
    fc.property(pattern, name, (each, imp) => {
      const like = new RegExp(`^${toLikePattern(each).replaceAll('%', '.*')}$`);

      expect(isImpAllowed([each], imp)).toBe(like.test(imp));
    }),
  );
});
