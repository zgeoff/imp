import { expect, test } from 'bun:test';
import { updateEnv } from './update-env';

test('it sets a variable to the override value', () => {
  updateEnv('IMP_TEST_UPDATE_ENV_SET', 'overridden');

  expect(process.env['IMP_TEST_UPDATE_ENV_SET']).toBe('overridden');
});

test('it unsets a variable when the override value is undefined', () => {
  updateEnv('PATH', undefined);

  expect(process.env).not.toContainKey('PATH');
});
