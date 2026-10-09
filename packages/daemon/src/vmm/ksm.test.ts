import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubSmapsMapping } from '../test-utils/build-stub-smaps-mapping';
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
    buildStubSmapsMapping({ start: 0x40_00_00, mib: 2, perms: 'r-xp', flags: '' }),
    buildStubSmapsMapping({
      start: 0x10_00_00_00,
      mib: 1,
      perms: 'rw-p',
      flags: '',
      backing: '[heap]',
    }),
    buildStubSmapsMapping({ start: 0x7f_00_00_00_00_00, mib: 512, perms: 'rw-p', flags: 'mg' }),
  ];

  expect(checkMergeableMappings(smaps.join('\n'))).toBeTrue();
});

test('#checkMergeableMappings finds guest memory without mg not mergeable', () => {
  const smaps = [
    buildStubSmapsMapping({ start: 0x40_00_00, mib: 2, perms: 'r-xp', flags: '' }),
    buildStubSmapsMapping({ start: 0x7f_00_00_00_00_00, mib: 512, perms: 'rw-p', flags: 'sd' }),
  ];

  expect(checkMergeableMappings(smaps.join('\n'))).toBeFalse();
});

test('#checkMergeableMappings finds no guest memory in a large mapping that is not private', () => {
  const smaps = [
    buildStubSmapsMapping({ start: 0x40_00_00, mib: 2, perms: 'r-xp', flags: '' }),
    buildStubSmapsMapping({ start: 0x7f_00_00_00_00_00, mib: 512, perms: 'rw-s', flags: '' }),
  ];

  expect(checkMergeableMappings(smaps.join('\n'))).toBeNull();
});

// as CI's 6.17 showed a template restore: the mem file in pieces, none of 64 MiB
test('#checkMergeableMappings checks the guest memory of a restore, split into small mappings, whole', () => {
  const smaps = [
    buildStubSmapsMapping({
      start: 0x40_00_00,
      mib: 2,
      perms: 'r-xp',
      flags: '',
      backing: '/firecracker',
    }),
    ...[54, 20, 2, 40, 60].map((mib, index) =>
      buildStubSmapsMapping({
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
    buildStubSmapsMapping({
      start: 0x40_00_00,
      mib: 2,
      perms: 'r-xp',
      flags: '',
      backing: '/firecracker',
    }),
    ...[54, 20, 2, 40, 60].map((mib, index) =>
      buildStubSmapsMapping({
        start: 0x7f_00_00_00_00_00 + index * 0x10_00_00_00,
        mib,
        perms: 'rw-p',
        flags: 'mg',
        backing: '/var/lib/imp/templates/abc/mem',
      }),
    ),
    buildStubSmapsMapping({
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
    buildStubSmapsMapping({
      start: 0x40_00_00,
      mib: 2,
      perms: 'r-xp',
      flags: '',
      backing: '/firecracker',
    }),
    ...[20, 2].map((mib, index) =>
      buildStubSmapsMapping({
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

  expect([...stat]).toStrictEqual([
    ['ksm_rmap_items', '5120'],
    ['ksm_zero_pages', '12'],
    ['ksm_merging_pages', '4096'],
    ['ksm_process_profit', '16252928'],
  ]);
});

test('#parseKsmStat reads the merge flags that 6.12 adds', () => {
  const stat = parseKsmStat(
    ['ksm_rmap_items 5120', 'ksm_merge_any: yes', 'ksm_mergeable: no'].join('\n'),
  );

  expect([...stat]).toStrictEqual([
    ['ksm_rmap_items', '5120'],
    ['ksm_merge_any', 'yes'],
    ['ksm_mergeable', 'no'],
  ]);
});

test('#parseKsmStat reads no merge flag from an older kernel', () => {
  expect(parseKsmStat('ksm_rmap_items 0\n').has('ksm_merge_any')).toBeFalse();
});

test('#checkGuestMemoryMergeable answers from ksm_merge_any when the kernel has it', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, '42'));
  writeFileSync(join(ctx.dir, '42', 'ksm_stat'), 'ksm_rmap_items 0\nksm_merge_any: yes\n');

  // smaps that says otherwise: ksm_merge_any wins
  writeFileSync(
    join(ctx.dir, '42', 'smaps'),
    buildStubSmapsMapping({ start: 0x7f_00_00_00_00_00, mib: 512, perms: 'rw-p', flags: '' }),
  );

  const mergeable = await checkGuestMemoryMergeable(42, ctx.dir);

  expect(mergeable).toBeTrue();
});

test('#checkGuestMemoryMergeable finds the guest memory not mergeable when ksm_merge_any says no', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, '42'));
  writeFileSync(join(ctx.dir, '42', 'ksm_stat'), 'ksm_rmap_items 0\nksm_merge_any: no\n');

  const mergeable = await checkGuestMemoryMergeable(42, ctx.dir);

  expect(mergeable).toBeFalse();
});

test('#checkGuestMemoryMergeable reads the smaps flags on a kernel before ksm_merge_any', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, '42'));
  writeFileSync(join(ctx.dir, '42', 'ksm_stat'), 'ksm_rmap_items 0\n');

  writeFileSync(
    join(ctx.dir, '42', 'smaps'),
    buildStubSmapsMapping({ start: 0x7f_00_00_00_00_00, mib: 512, perms: 'rw-p', flags: 'mg' }),
  );

  const mergeable = await checkGuestMemoryMergeable(42, ctx.dir);

  expect(mergeable).toBeTrue();
});

test('#checkGuestMemoryMergeable cannot say for a process that is gone', async () => {
  const ctx = setupTest();

  const mergeable = await checkGuestMemoryMergeable(42, ctx.dir);

  expect(mergeable).toBeNull();
});

test('#readKsmProfitMib reads ksm_process_profit in MiB', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, '42'));

  writeFileSync(
    join(ctx.dir, '42', 'ksm_stat'),
    `ksm_rmap_items 5120\nksm_process_profit ${String(24 * 1024 ** 2)}\n`,
  );

  const profitMib = await readKsmProfitMib(42, ctx.dir);

  expect(profitMib).toBe(24);
});

test('#readKsmProfitMib reads a negative profit while little is merged', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, '42'));
  writeFileSync(join(ctx.dir, '42', 'ksm_stat'), `ksm_process_profit ${String(-2 * 1024 ** 2)}\n`);

  const profitMib = await readKsmProfitMib(42, ctx.dir);

  expect(profitMib).toBe(-2);
});

test('#readKsmProfitMib reads nothing from a kernel without ksm_process_profit', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, '42'));
  writeFileSync(join(ctx.dir, '42', 'ksm_stat'), 'ksm_rmap_items 5120\n');

  const profitMib = await readKsmProfitMib(42, ctx.dir);

  expect(profitMib).toBeNull();
});

test('#readKsmProfitMib reads nothing for a process that is gone', async () => {
  const ctx = setupTest();

  const profitMib = await readKsmProfitMib(42, ctx.dir);

  expect(profitMib).toBeNull();
});

test('#readKsmProfitMib reads the host /proc by default', async () => {
  const gone = Bun.spawn(['true']);

  await gone.exited;

  const profitMib = await readKsmProfitMib(gone.pid);

  expect(profitMib).toBeNull();
});
