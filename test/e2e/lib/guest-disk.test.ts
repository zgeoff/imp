import { expect, test } from 'bun:test';
import { buildImpDiskPath, parseDfSizeKib } from './guest-disk';

test('#parseDfSizeKib reads the size column of the last line', () => {
  const stdout = [
    'Filesystem           1K-blocks      Used Available Use% Mounted on',
    '/dev/vda             102626232     41020  98375404   0% /',
    '',
  ].join('\n');

  expect(parseDfSizeKib(stdout)).toBe(102_626_232);
});

test('#parseDfSizeKib throws on output with no size', () => {
  expect(() => parseDfSizeKib('df: /: No such file or directory\n')).toThrowWithMessage(
    TypeError,
    String.raw`no size in df output: "df: /: No such file or directory\n"`,
  );
});

test.each([
  ['xfs', '/var/lib/imp/imps/abc/disk.ext4'],
  ['zfs', '/var/lib/imp/imps/abc/disk/rootfs.ext4'],
] as const)('#buildImpDiskPath places a %s disk at %s', (backend, expected) => {
  expect(buildImpDiskPath(backend, 'abc')).toBe(expected);
});
