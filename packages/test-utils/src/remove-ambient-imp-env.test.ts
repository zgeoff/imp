import { expect, test } from 'bun:test';
import { removeAmbientImpEnv } from './remove-ambient-imp-env';
import { updateEnv } from './update-env';

test('it removes an impd setting from the environment', () => {
  updateEnv('IMP_RAM_BUDGET_MIB', '800');
  removeAmbientImpEnv();

  expect(process.env).not.toContainKey('IMP_RAM_BUDGET_MIB');
});

test.each([['IMP_HOST_TESTS'], ['IMP_TEST_SMALL_FS'], ['IMP_TEST_ZFS_ROOT'], ['IMP_TEST_ZFS_DIR']])(
  'it keeps the run gate %s',
  (key) => {
    updateEnv(key, 'kept');
    removeAmbientImpEnv();

    expect(process.env[key]).toBe('kept');
  },
);

test('it keeps a variable without the IMP_ prefix', () => {
  updateEnv('NOT_IMP_SETTING', 'kept');
  removeAmbientImpEnv();

  expect(process.env['NOT_IMP_SETTING']).toBe('kept');
});
