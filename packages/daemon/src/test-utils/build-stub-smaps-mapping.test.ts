import { expect, test } from 'bun:test';
import { buildStubSmapsMapping } from './build-stub-smaps-mapping';

test('it prints a private writable anonymous mapping as smaps does', () => {
  expect(buildStubSmapsMapping({ start: 0x40_00_00, mib: 2, perms: 'rw-p', flags: 'mg' })).toBe(
    [
      '400000-600000 rw-p 00000000 00:00 0',
      'Rss:                 100 kB',
      'VmFlags: rd wr mr mw me ac mg',
    ].join('\n'),
  );
});

test('it prints no write flags for a read-only executable mapping', () => {
  const mapping = buildStubSmapsMapping({
    start: 0x40_00_00,
    mib: 1,
    perms: 'r-xp',
    flags: '',
    backing: '/firecracker',
  });

  expect(mapping.split('\n')).toStrictEqual([
    '400000-500000 r-xp 00000000 00:00 0 /firecracker',
    'Rss:                 100 kB',
    'VmFlags: rd ex mr mw me',
  ]);
});

test('it prints a shared mapping with sh and without ac', () => {
  const mapping = buildStubSmapsMapping({ start: 0x40_00_00, mib: 1, perms: 'rw-s', flags: '' });

  expect(mapping.split('\n').at(-1)).toBe('VmFlags: rd wr sh mr mw me');
});
