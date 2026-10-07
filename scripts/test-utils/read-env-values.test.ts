import { expect, test } from 'bun:test';
import { readEnvValues } from './read-env-values';

test('it reads the value of the line that sets the key', () => {
  expect(readEnvValues('IMP_A=1\nIMP_B=two words\n', 'IMP_B')).toStrictEqual(['two words']);
});

test('it reads every value, in order, when several lines set the key', () => {
  expect(readEnvValues('IMP_A=1\nIMP_A=\nIMP_A=3', 'IMP_A')).toStrictEqual(['1', '', '3']);
});

test('it reads nothing when no line sets the key', () => {
  expect(readEnvValues('# IMP_A=1\nIMP_AB=2\n', 'IMP_A')).toStrictEqual([]);
});
