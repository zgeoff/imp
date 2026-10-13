import { expect, test } from 'bun:test';
import { parseMountInfo, parseMounts, readMounts } from './mounts';

test('#parseMounts reads the source, target and type of each line', () => {
  expect(parseMounts('pool/imp /data zfs rw,xattr 0 0\nproc /proc proc rw 0 0\n')).toStrictEqual([
    { source: 'pool/imp', target: '/data', fstype: 'zfs' },
    { source: 'proc', target: '/proc', fstype: 'proc' },
  ]);
});

test('#parseMounts decodes the octal escapes of a space, a tab, a newline and a backslash', () => {
  expect(parseMounts(String.raw`a\040b /x\011y\012z\134 ext4 rw 0 0`)).toStrictEqual([
    { source: 'a b', target: '/x\ty\nz\\', fstype: 'ext4' },
  ]);
});

test('#parseMountInfo reads the mount point, type and source past the separator', () => {
  expect(
    parseMountInfo('36 35 98:0 / /mnt/my\\040disk rw,noatime master:1 - xfs /dev/loop3 rw,attr2\n'),
  ).toStrictEqual([{ mountPoint: '/mnt/my disk', fstype: 'xfs', source: '/dev/loop3' }]);
});

test('#readMounts reads the mount table of this process', () => {
  expect(parseMounts(readMounts())).toPartiallyContain({ target: '/proc', fstype: 'proc' });
});
