import { expect, test } from 'bun:test';
import { updateEnv } from '@imp/test-utils/update-env';
import { readZfsTestPool } from './read-zfs-test-pool';

test('it reads the pool dataset and its mount dir', () => {
  updateEnv('IMP_TEST_ZFS_ROOT', 'imptest123/imp');
  updateEnv('IMP_TEST_ZFS_DIR', '/tmp/imp-zfs/mnt');

  expect(readZfsTestPool()).toStrictEqual({
    parent: 'imptest123/imp',
    parentDir: '/tmp/imp-zfs/mnt',
  });
});

test('it gives no pool when the dataset is not set', () => {
  updateEnv('IMP_TEST_ZFS_ROOT', undefined);
  updateEnv('IMP_TEST_ZFS_DIR', '/tmp/imp-zfs/mnt');

  expect(readZfsTestPool()).toBeNull();
});

test('it gives no pool when the mount dir is not set', () => {
  updateEnv('IMP_TEST_ZFS_ROOT', 'imptest123/imp');
  updateEnv('IMP_TEST_ZFS_DIR', undefined);

  expect(readZfsTestPool()).toBeNull();
});
