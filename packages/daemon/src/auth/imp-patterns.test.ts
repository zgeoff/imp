import { expect, test } from 'bun:test';
import { isImpAllowed } from '@imp/api';
import fc from 'fast-check';
import { toLikePattern } from './imp-patterns';

test('it turns each * into the % of a LIKE pattern', () => {
  expect(toLikePattern('a*b*')).toBe('a%b%');
});

test('it leaves a pattern without * as it is', () => {
  expect(toLikePattern('exact')).toBe('exact');
});

test('it makes LIKE patterns that agree with the matcher the API uses', () => {
  const name = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/);
  const pattern = fc.stringMatching(/^[a-z*][a-z0-9*-]{0,6}$/);

  // a failure reports its seed and shrunk counterexample, to replay it
  expect(() => {
    fc.assert(
      fc.property(pattern, name, (each, imp) => {
        const like = new RegExp(`^${toLikePattern(each).replaceAll('%', '.*')}$`);

        return isImpAllowed([each], imp) === like.test(imp);
      }),
    );
  }).not.toThrow();
});
