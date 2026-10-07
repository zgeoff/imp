import { expect, test } from 'bun:test';
import { invariant } from './invariant';

test('it returns for a present value', () => {
  expect(() => {
    invariant(0);
  }).not.toThrow();
});

test('it throws for an undefined value', () => {
  expect(() => {
    invariant(undefined);
  }).toThrowWithMessage(Error, 'expected a value');
});

test('it throws for a null value with the given message', () => {
  expect(() => {
    invariant(null, 'expected a token');
  }).toThrowWithMessage(Error, 'expected a token');
});
