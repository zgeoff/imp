import { expect, test } from 'bun:test';
import { mergeEnv, readEnvKey } from './merge-env';

test('#mergeEnv lets the caller win key by key, with each key once in first-seen order', () => {
  expect(mergeEnv(['A=1', 'B=2'], ['B=3', 'C=4'])).toStrictEqual(['A=1', 'B=3', 'C=4']);
});

test('#mergeEnv keeps the base when the caller sets nothing', () => {
  expect(mergeEnv(['A=1'], [])).toStrictEqual(['A=1']);
});

test('#mergeEnv keeps a value that holds an equals sign whole', () => {
  expect(mergeEnv([], ['X=a=b'])).toStrictEqual(['X=a=b']);
});

test.each([
  ['A=1', 'A'],
  ['X=a=b', 'X'],
  ['EMPTY=', 'EMPTY'],
  ['BARE', 'BARE'],
])('#readEnvKey reads the key of %s as %s', (entry, key) => {
  expect(readEnvKey(entry)).toBe(key);
});
