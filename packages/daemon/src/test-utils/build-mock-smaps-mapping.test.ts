import { expect, test } from 'bun:test';
import { buildMockSmapsMapping } from './build-mock-smaps-mapping';

test('it prints an anonymous mapping as smaps does', () => {
  expect(buildMockSmapsMapping({ start: 0x40_00_00, mib: 2, perms: 'rw-p', flags: 'mg' })).toBe(
    [
      '400000-600000 rw-p 00000000 00:00 0',
      'Rss:                 100 kB',
      'VmFlags: rd wr mr mw me ac mg',
    ].join('\n'),
  );
});

test('it prints the backing of a mapped file after the header', () => {
  const mapping = buildMockSmapsMapping({
    start: 0x40_00_00,
    mib: 1,
    perms: 'r-xp',
    flags: '',
    backing: '/firecracker',
  });

  expect(mapping.split('\n')).toStrictEqual([
    '400000-500000 r-xp 00000000 00:00 0 /firecracker',
    'Rss:                 100 kB',
    'VmFlags: rd wr mr mw me ac',
  ]);
});
