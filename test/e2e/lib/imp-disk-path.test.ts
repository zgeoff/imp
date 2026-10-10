import { expect, test } from 'bun:test';
import { buildImpDiskPath } from './imp-disk-path';

test.each([
  ['xfs', '/var/lib/imp/imps/abc/disk.ext4'],
  ['zfs', '/var/lib/imp/imps/abc/disk/rootfs.ext4'],
] as const)('it finds the disk file of an imp on %s at %s', (backend, path) => {
  expect(buildImpDiskPath(backend, 'abc')).toBe(path);
});
