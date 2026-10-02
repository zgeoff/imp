import { expect, test } from 'bun:test';
import { findLoopBackingFile } from './loop-backing-file';

const MOUNTINFO = [
  '22 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw',
  '98 22 7:3 / /var/lib/imp rw,relatime - xfs /dev/loop3 rw,attr2',
  '',
].join('\n');

function buildFiles(texts: Readonly<Record<string, string>>) {
  return {
    readText: (path: string) => {
      const text = texts[path];

      if (text === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }

      return text;
    },
    resolvePath: (path: string) => path,
  };
}

test('a loop mount names the file behind its loop device', () => {
  const files = buildFiles({
    '/proc/self/mountinfo': MOUNTINFO,
    '/sys/block/loop3/loop/backing_file': '/srv/imp/xfs.img\n',
  });

  expect(findLoopBackingFile('/var/lib/imp', files)).toBe('/srv/imp/xfs.img');
  expect(findLoopBackingFile('/', files)).toBeNull();
});

test('an unreadable sysfs leaves the filesystem count alone', () => {
  const files = buildFiles({ '/proc/self/mountinfo': MOUNTINFO });

  expect(findLoopBackingFile('/var/lib/imp', files)).toBeNull();
});
