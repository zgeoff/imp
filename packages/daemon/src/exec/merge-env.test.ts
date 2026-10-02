import { expect, test } from 'bun:test';
import { mergeEnv } from './merge-env';

test('the caller wins key by key, and each key appears once', () => {
  expect(mergeEnv(['A=1', 'B=2'], ['B=3', 'C=4'])).toEqual(['A=1', 'B=3', 'C=4']);
  expect(mergeEnv(['A=1'], [])).toEqual(['A=1']);
  expect(mergeEnv([], ['X=a=b'])).toEqual(['X=a=b']);
});
