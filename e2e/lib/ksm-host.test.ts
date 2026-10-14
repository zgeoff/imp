import { expect, test } from 'bun:test';
import {
  checkKernelSupportsKsm,
  parseCpuMsFromStat,
  parseGuestMappings,
  parsePssMib,
} from './ksm-host';

test.each([
  ['6.10.0-1-generic', true],
  ['7.0.2', true],
  ['6.9.12', false],
  ['5.15.167.4-microsoft-standard-WSL2', false],
  ['', false],
])('#checkKernelSupportsKsm reads release %s as %p', (release, expected) => {
  expect(checkKernelSupportsKsm(release)).toBe(expected);
});

test('#parseCpuMsFromStat adds utime and stime past a name with spaces', () => {
  const stat = '42 (ksm d) S 2 0 0 0 -1 2129984 0 0 0 0 150 25 0 0 25 5 1 0 3 0 0';

  expect(parseCpuMsFromStat(stat)).toBe(1750);
});

test('#parsePssMib adds the anonymous and shmem Pss', () => {
  const rollup = [
    '00400000-7ffd0000 ---p 00000000 00:00 0 [rollup]',
    'Rss:              800000 kB',
    'Pss:              700000 kB',
    'Pss_Anon:         409600 kB',
    'Pss_File:          10240 kB',
    'Pss_Shmem:        102400 kB',
  ].join('\n');

  expect(parsePssMib(rollup)).toBe(500);
});

test('#parseGuestMappings reads the mappings of the backing that holds the guest', () => {
  const smaps = [
    '7f0000000000-7f0010000000 rw-p 00000000 00:00 0 ',
    'VmFlags: rd wr mr mw me ac mg',
    '7f0010000000-7f0020000000 rw-p 00000000 00:00 0 ',
    'VmFlags: rd wr mr mw me ac mg',
    '7f0020000000-7f0020200000 r-xp 00000000 08:01 5 /usr/bin/firecracker',
    'VmFlags: rd ex mr mw me',
    '7f0030000000-7f0030100000 ---p 00000000 00:00 0 ',
    'VmFlags: mr mw me',
  ].join('\n');

  expect(parseGuestMappings(smaps, 256)).toStrictEqual(['rw-p mg', 'rw-p mg']);
});

test('#parseGuestMappings reads shared memfd memory without the mergeable flag', () => {
  const smaps = [
    '7f0000000000-7f0020000000 rw-s 00000000 00:01 9 /memfd:guest_mem (deleted)',
    'VmFlags: rd wr sh mr mw me ms',
  ].join('\n');

  expect(parseGuestMappings(smaps, 256)).toStrictEqual(['rw-s']);
});

test('#parseGuestMappings finds nothing when no backing holds the guest', () => {
  const smaps = [
    '7f0000000000-7f0004000000 rw-p 00000000 00:00 0 ',
    'VmFlags: rd wr mr mw me ac mg',
  ].join('\n');

  expect(parseGuestMappings(smaps, 256)).toStrictEqual([]);
});
