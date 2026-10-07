import { expect, test } from 'bun:test';
import { removeEnvOverrides } from './remove-env-overrides';
import { updateEnv } from './update-env';

test('it puts a set variable back to its value before the first override', () => {
  const original = process.env['PATH'];

  updateEnv('PATH', '/first');
  updateEnv('PATH', '/second');
  removeEnvOverrides();

  expect(process.env['PATH']).toBe(original);
});

test('it puts back a variable that an override unset', () => {
  const original = process.env['HOME'];

  updateEnv('HOME', undefined);
  removeEnvOverrides();

  expect(process.env['HOME']).toBe(original);
});

test('it unsets a variable that was unset before its override', () => {
  updateEnv('IMP_TEST_REMOVE_ENV_OVERRIDES_UNSET', 'overridden');
  removeEnvOverrides();

  expect(process.env).not.toContainKey('IMP_TEST_REMOVE_ENV_OVERRIDES_UNSET');
});
