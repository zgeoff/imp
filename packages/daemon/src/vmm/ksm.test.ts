import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkKsmHost,
  checkKsmKernel,
  checkMergeableMappings,
  parseKsmStat,
  readKsmHostStats,
} from './ksm';
import { countUnsharedMib, parseSmapsRollup } from './vm-stats';

test('IMP_KSM needs Linux 6.10 or later', () => {
  expect(checkKsmKernel('6.10.0')).toBeNull();
  expect(checkKsmKernel('6.17.0-1022-azure')).toBeNull();
  expect(checkKsmKernel('7.0.0-1012-azure')).toBeNull();
  expect(checkKsmKernel('6.9.12')).toContain('Linux 6.10 or later');
  expect(checkKsmKernel('6.6.87.2-microsoft-standard-WSL2')).toContain('this host runs 6.6.87.2');
  expect(checkKsmKernel('garbage')).toContain('Linux 6.10 or later');
});

test('IMP_KSM also needs a kernel built with KSM', () => {
  const stats = { running: false, sharedMib: 0, profitMib: 0, zeroMib: 0 };

  expect(checkKsmHost('6.12.0', stats)).toBeNull();
  expect(checkKsmHost('6.12.0', null)).toContain('CONFIG_KSM');
  expect(checkKsmHost('6.6.0', stats)).toContain('Linux 6.10 or later');
});

// a mapping's smaps lines: its header, then VmFlags
function writeMapping(start: number, mib: number, perms: string, flags: string): string {
  const end = start + mib * 1024 ** 2;

  return [
    `${start.toString(16)}-${end.toString(16)} ${perms} 00000000 00:00 0`,
    'Rss:                 100 kB',
    `VmFlags: rd wr mr mw me ac ${flags}`,
  ].join('\n');
}

test('guest memory is mergeable when every large private writable mapping has mg', () => {
  const firecracker = writeMapping(0x40_00_00, 2, 'r-xp', '');
  const heap = writeMapping(0x10_00_00_00, 1, 'rw-p', '');
  const guest = writeMapping(0x7f_00_00_00_00_00, 512, 'rw-p', 'mg');

  expect(checkMergeableMappings([firecracker, heap, guest].join('\n'))).toBe(true);

  const unflagged = writeMapping(0x7f_00_00_00_00_00, 512, 'rw-p', 'sd');

  expect(checkMergeableMappings([firecracker, heap, unflagged].join('\n'))).toBe(false);

  // a large mapping that is not private and writable is not guest memory
  const shared = writeMapping(0x7f_00_00_00_00_00, 512, 'rw-s', '');

  expect(checkMergeableMappings([firecracker, shared].join('\n'))).toBeNull();
});

test('the unshared size counts anonymous pages in full, not their Pss', () => {
  const fields = parseSmapsRollup(
    [
      'Pss_Anon:          51200 kB',
      'Anonymous:        153600 kB',
      'Pss_Shmem:          1024 kB',
    ].join('\n'),
  );

  expect(countUnsharedMib(fields)).toBe(151);
});

test('it reads the host counters from the KSM sysfs directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-ksm-'));

  try {
    writeFileSync(join(dir, 'run'), '1\n');
    writeFileSync(join(dir, 'pages_sharing'), '25600\n');
    writeFileSync(join(dir, 'general_profit'), String(90 * 1024 ** 2));
    writeFileSync(join(dir, 'ksm_zero_pages'), '512\n');

    expect(readKsmHostStats(dir)).toEqual({
      running: true,
      sharedMib: 100,
      profitMib: 90,
      zeroMib: 2,
    });

    rmSync(join(dir, 'run'));

    expect(readKsmHostStats(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('it reads ksm_stat, with the merge flags that 6.12 adds', () => {
  const stat = parseKsmStat(
    [
      'ksm_rmap_items 5120',
      'ksm_zero_pages 12',
      'ksm_merging_pages 4096',
      'ksm_process_profit 16252928',
      'ksm_merge_any: yes',
      'ksm_mergeable: yes',
    ].join('\n'),
  );

  expect(stat.get('ksm_process_profit')).toBe('16252928');
  expect(stat.get('ksm_merge_any')).toBe('yes');
  expect(parseKsmStat('ksm_rmap_items 0\n').has('ksm_merge_any')).toBe(false);
});
