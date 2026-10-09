import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countUnsharedMib,
  parseSmapsRollup,
  readCpuTicks,
  readOwnedRamMib,
  readRssMib,
  readUnsharedRamMib,
  readVmMemory,
} from './vm-stats';

// an empty /proc in a temp dir; the test writes each process's files
function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-vm-stats-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const procRoot = join(dir, 'proc');

  mkdirSync(procRoot);

  return { procRoot };
}

test('#parseSmapsRollup reads the kB fields of smaps_rollup', () => {
  const fields = parseSmapsRollup(
    [
      '7f0000000000-7fffffffffff ---p 00000000 00:00 0                          [rollup]',
      'Rss:              349184 kB',
      'Pss_Anon:          15360 kB',
      'Private_Dirty:     15400 kB',
      'THPeligible:    0',
    ].join('\n'),
  );

  expect([...fields]).toStrictEqual([
    ['Rss', 349_184],
    ['Pss_Anon', 15_360],
    ['Private_Dirty', 15_400],
  ]);
});

test('#countUnsharedMib counts anonymous and shmem pages in full, in MiB', () => {
  expect(
    countUnsharedMib(
      new Map([
        ['Anonymous', 2048],
        ['Pss_Anon', 512],
        ['Pss_Shmem', 1024],
      ]),
    ),
  ).toBe(3);
});

test('#readOwnedRamMib counts the anonymous and shmem Pss of a live firecracker', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  writeFileSync(
    join(ctx.procRoot, '42', 'smaps_rollup'),
    'Rss:              409600 kB\nPss_Anon:          204800 kB\nPss_Shmem:          51200 kB\nAnonymous:         307200 kB\n',
  );

  expect(readOwnedRamMib(42, '/run/api.sock', ctx.procRoot)).toBe(250);
});

test('#readUnsharedRamMib counts the anonymous pages in full and the shmem Pss', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  writeFileSync(
    join(ctx.procRoot, '42', 'smaps_rollup'),
    'Rss:              409600 kB\nPss_Anon:          204800 kB\nPss_Shmem:          51200 kB\nAnonymous:         307200 kB\n',
  );

  expect(readUnsharedRamMib(42, '/run/api.sock', ctx.procRoot)).toBe(350);
});

test('#readRssMib reads the resident size of a live firecracker', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  writeFileSync(
    join(ctx.procRoot, '42', 'smaps_rollup'),
    'Rss:              409600 kB\nPss_Anon:          204800 kB\nPss_Shmem:          51200 kB\nAnonymous:         307200 kB\n',
  );

  expect(readRssMib(42, '/run/api.sock', ctx.procRoot)).toBe(400);
});

test('#readVmMemory reads the counted and the resident size in one read', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  writeFileSync(
    join(ctx.procRoot, '42', 'smaps_rollup'),
    'Rss:              409600 kB\nPss_Anon:          204800 kB\nPss_Shmem:          51200 kB\nAnonymous:         307200 kB\n',
  );

  expect(readVmMemory(42, '/run/api.sock', ctx.procRoot)).toStrictEqual({
    ramMib: 250,
    rssMib: 400,
  });
});

test('#readOwnedRamMib rounds to whole MiB', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');
  writeFileSync(join(ctx.procRoot, '42', 'smaps_rollup'), 'Pss_Anon:            1600 kB\n');

  expect(readOwnedRamMib(42, '/run/api.sock', ctx.procRoot)).toBe(2);
});

test('#readOwnedRamMib reads nothing for a pid that serves another socket', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/other.sock\0');
  writeFileSync(join(ctx.procRoot, '42', 'smaps_rollup'), 'Pss_Anon:          204800 kB\n');

  expect(readOwnedRamMib(42, '/run/api.sock', ctx.procRoot)).toBeNull();
});

test('#readOwnedRamMib reads nothing for a zombie firecracker', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) Z 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');
  writeFileSync(join(ctx.procRoot, '42', 'smaps_rollup'), 'Pss_Anon:          204800 kB\n');

  expect(readOwnedRamMib(42, '/run/api.sock', ctx.procRoot)).toBeNull();
});

test('#readRssMib reads nothing for a firecracker without smaps_rollup', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));
  writeFileSync(join(ctx.procRoot, '42', 'stat'), '42 (firecracker) S 1 42 42 0 -1');
  writeFileSync(join(ctx.procRoot, '42', 'cmdline'), 'firecracker\0--api-sock\0/run/api.sock\0');

  expect(readRssMib(42, '/run/api.sock', ctx.procRoot)).toBeNull();
});

test('#readVmMemory reads nothing for a pid that is gone', () => {
  const ctx = setupTest();

  expect(readVmMemory(42, '/run/api.sock', ctx.procRoot)).toStrictEqual({
    ramMib: null,
    rssMib: null,
  });
});

test('#readUnsharedRamMib reads nothing for a pid that is gone', () => {
  const ctx = setupTest();

  expect(readUnsharedRamMib(42, '/run/api.sock', ctx.procRoot)).toBeNull();
});

test('#readCpuTicks adds the user and system ticks of stat', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));

  writeFileSync(
    join(ctx.procRoot, '42', 'stat'),
    '42 (firecracker) S 1 42 42 0 -1 4194560 100 0 0 0 1500 250 0 0 20 0 3 0',
  );

  expect(readCpuTicks(42, ctx.procRoot)).toBe(1750);
});

test('#readCpuTicks reads past a command name with spaces and parentheses', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.procRoot, '42'));

  writeFileSync(
    join(ctx.procRoot, '42', 'stat'),
    '42 (fc (vm) 1) S 1 42 42 0 -1 4194560 100 0 0 0 1500 250 0 0 20 0 3 0',
  );

  expect(readCpuTicks(42, ctx.procRoot)).toBe(1750);
});

test('#readCpuTicks reads nothing for a process that is gone', () => {
  const ctx = setupTest();

  expect(readCpuTicks(42, ctx.procRoot)).toBeNull();
});

test('#readCpuTicks reads the host /proc by default', () => {
  expect(readCpuTicks(process.pid)).toSatisfy(Number.isSafeInteger);
});
