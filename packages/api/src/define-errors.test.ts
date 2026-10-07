import { expect, test } from 'bun:test';
import { defineErrors } from './define-errors';

test('it returns the error map it is given', () => {
  const errors = {
    NOT_FOUND: { message: 'Not found' },
    TEAPOT: { message: 'I am a teapot', status: 418 },
  };

  expect(defineErrors(errors)).toBe(errors);
});
