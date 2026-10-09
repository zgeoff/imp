import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMockSmapsMapping } from '../test-utils/build-mock-smaps-mapping';
import {
  checkGuestMemoryMergeable,
  checkKsmHost,
  checkKsmKernel,
  checkMergeableMappings,
  parseKsmStat,
  readKsmHostStats,
  readKsmProfitMib,
} from './ksm';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-ksm-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

test.each(['6.10.0', '6.17.0-1022-azure', '7.0.0-1012-azure'])(
  '#checkKsmKernel accepts Linux %s',
  (release) => {
    expect(checkKsmKernel(release)).toBeNull();
  },
);

test.each(['6.9.12', 'garbage'])(
  '#checkKsmKernel asks for Linux 6.10 or later on %s',
  (release) => {
    expect(checkKsmKernel(release)).toContain('Linux 6.10 or later');
  },
);

test('#checkKsmKernel names the release the host runs', () => {
  expect(checkKsmKernel('6.6.87.2-microsoft-standard-WSL2')).toContain('this host runs 6.6.87.2');
});

test('#checkKsmHost accepts a recent kernel built with KSM', () => {
  expect(
    checkKsmHost('6.12.0', { running: false, sharedMib: 0, profitMib: 0, zeroMib: 0 }),
  ).toBeNull();
});

test('#checkKsmHost asks for CONFIG_KSM on a kernel without KSM', () => {
  expect(checkKsmHost('6.12.0', null)).toContain('CONFIG_KSM');
});

test('#checkKsmHost asks for Linux 6.10 or later on an older kernel with KSM', () => {
  expect(
    checkKsmHost('6.6.0', { running: false, sharedMib: 0, profitMib: 0, zeroMib: 0 }),
  ).toContain('Linux 6.10 or later');
});

test('#checkMergeableMappings finds guest memory mergeable when its large private writable mapping has mg', () => {
  const smaps = [
    buildMockSmapsMapping({ start: 0x40_00_00, mib: 2, perms: 'r-xp', flags: '' }),
    buildMockSmapsMapping({
      start: 0x10_00_00_00,
      mib: 1,
      perms: 'rw-p',
      flags: '',
      backing: '[heap]',
    }),
    buildMockSmapsMapping({ start: 0x7f_00_00_00_00_00, mib: 512, perms: 'rw-p', flags: 'mg' }),
  ];

  expect(checkMergeableMappings(smaps.join('\n'))).toBeTrue();
});

test('#checkMergeableMappings finds guest memory without mg not mergeable', () => {
  const smaps = [
    buildMockSmapsMapping({ start: 0x40_00_00, mib: 2, perms: 'r-xp', flags: '' }),
    buildMockSmapsMapping({ start: 0x7f_00_00_00_00_00, mib: 512, perms: 'rw-p', flags: 'sd' }),
  ];

  expect(checkMergeableMappings(smaps.join('\n'))).toBeFalse();
});

test('#checkMergeableMappings finds no guest memory in a large mapping that is not private', () => {
  const smaps = [
    buildMockSmapsMapping({ start: 0x40_00_00, mib: 2, perms: 'r-xp', flags: '' }),
    buildMockSmapsMapping({ start: 0x7f_00_00_00_00_00, mib: 512, perms: 'rw-s', flags: '' }),
  ];

  expect(checkMergeableMappings(smaps.join('\n'))).toBeNull();
});

// as CI's 6.17 showed a template restore: the mem file in pieces, none of 64 MiB
test('#checkMergeableMappings checks the guest memory of a restore, split into small mappings, whole', () => {
  const smaps = [
    buildMockSmapsMapping({
      start: 0x40_00_00,
      mib: 2,
      perms: 'r-xp',
      flags: '',
      backing: '/firecracker',
    }),
    ...[54, 20, 2, 40, 60].map((mib, index) =>
      buildMockSmapsMapping({
        start: 0x7f_00_00_00_00_00 + index * 0x10_00_00_00,
        mib,
        perms: 'rw-p',
        flags: 'mg',
        backing: '/var/lib/imp/templates/abc/mem',
      }),
    ),
  ];

  expect(checkMergeableMappings(smaps.join('\n'))).toBeTrue();
});

test('#checkMergeableMappings finds a restore not mergeable when one of its pieces lacks mg', () => {
  const smaps = [
    buildMockSmapsMapping({
      start: 0x40_00_00,
      mib: 2,
      perms: 'r-xp',
      flags: '',
      backing: '/firecracker',
    }),
    ...[54, 20, 2, 40, 60].map((mib, index) =>
      buildMockSmapsMapping({
        start: 0x7f_00_00_00_00_00 + index * 0x10_00_00_00,
        mib,
        perms: 'rw-p',
        flags: 'mg',
        backing: '/var/lib/imp/templates/abc/mem',
      }),
    ),
    buildMockSmapsMapping({
      start: 0x7f_10_00_00_00_00,
      mib: 30,
      perms: 'rw-p',
      flags: 'sd',
      backing: '/var/lib/imp/templates/abc/mem',
    }),
  ];

  expect(checkMergeableMappings(smaps.join('\n'))).toBeFalse();
});

test('#checkMergeableMappings finds no guest memory in the pieces of a small backing', () => {
  const smaps = [
    buildMockSmapsMapping({
      start: 0x40_00_00,
      mib: 2,
      perms: 'r-xp',
      flags: '',
      backing: '/firecracker',
    }),
    ...[20, 2].map((mib, index) =>
      buildMockSmapsMapping({
        start: 0x7f_00_00_00_00_00 + index * 0x10_00_00_00,
        mib,
        perms: 'rw-p',
        flags: 'mg',
        backing: '/var/lib/imp/templates/abc/mem',
      }),
    ),
  ];

  expect(checkMergeableMappings(smaps.join('\n'))).toBeNull();
});

test('#readKsmHostStats reads the host counters from the KSM sysfs directory', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'run'), '1\n');
  writeFileSync(join(ctx.dir, 'pages_sharing'), '25600\n');
  writeFileSync(join(ctx.dir, 'general_profit'), String(90 * 1024 ** 2));
  writeFileSync(join(ctx.dir, 'ksm_zero_pages'), '512\n');

  expect(readKsmHostStats(ctx.dir)).toStrictEqual({
    running: true,
    sharedMib: 100,
    profitMib: 90,
    zeroMib: 2,
  });
});

test('#readKsmHostStats reads no counters from a directory without run', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'pages_sharing'), '25600\n');
  writeFileSync(join(ctx.dir, 'general_profit'), String(90 * 1024 ** 2));
  writeFileSync(join(ctx.dir, 'ksm_zero_pages'), '512\n');

  expect(readKsmHostStats(ctx.dir)).toBeNull();
});

test('#parseKsmStat reads each counter of ksm_stat', () => {
  const stat = parseKsmStat(
    [
      'ksm_rmap_items 5120',
      'ksm_zero_pages 12',
      'ksm_merging_pages 4096',
      'ksm_process_profit 16252928',
    ].join('\n'),
  );

  expect(stat.get('ksm_process_profit')).toBe('16252928');
});

test('#parseKsmStat reads the merge flags that 6.12 adds', () => {
  const stat = parseKsmStat(
    ['ksm_rmap_items 5120', 'ksm_merge_any: yes', 'ksm_mergeable: yes'].join('\n'),
  );

  expect(stat.get('ksm_merge_any')).toBe('yes');
});

test('#parseKsmStat reads no merge flag from an older kernel', () => {
  expect(parseKsmStat('ksm_rmap_items 0\n').has('ksm_merge_any')).toBeFalse();
});

test('#checkGuestMemoryMergeable cannot say for a process that is gone', async () => {
  const gone = Bun.spawn(['true']);

  await gone.exited;

  const mergeable = await checkGuestMemoryMergeable(gone.pid);

  expect(mergeable).toBeNull();
});

test('#readKsmProfitMib reads nothing for a process that is gone', async () => {
  const gone = Bun.spawn(['true']);

  await gone.exited;

  const profitMib = await readKsmProfitMib(gone.pid);

  expect(profitMib).toBeNull();
});
