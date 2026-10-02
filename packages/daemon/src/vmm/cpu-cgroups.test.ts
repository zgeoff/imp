import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCpuCgroups, formatCpuMax, parseCpuStat } from './cpu-cgroups';

// a cgroup root and a /proc in a temp dir, with cpu handed to imps/ unless
// `delegated` is false, as setup-cgroups.sh leaves it
function setupCgroups(delegated = true) {
  const dir = mkdtempSync(join(tmpdir(), 'imp-cgroups-'));
  const root = join(dir, 'cgroup');
  const proc = join(dir, 'proc');
  const logs: string[] = [];

  mkdirSync(join(root, 'imps'), { recursive: true });
  mkdirSync(proc);

  if (delegated) {
    writeFileSync(join(root, 'imps', 'cgroup.subtree_control'), 'cpu\n');
  }

  const cgroups = createCpuCgroups({
    root,
    procRoot: proc,
    log: (message) => {
      logs.push(message);
    },
  });

  // the files the kernel would make in a new cgroup
  const readFile = (impId: string, file: string): string =>
    readFileSync(join(root, 'imps', impId, file), 'utf8');

  const setProcessCgroup = (pid: number, path: string): void => {
    mkdirSync(join(proc, String(pid)), { recursive: true });
    writeFileSync(join(proc, String(pid), 'cgroup'), `0::${path}\n`);
  };

  return {
    root,
    cgroups,
    logs,
    readFile,
    setProcessCgroup,
    [Symbol.dispose]: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('cpu.max is the limit in microseconds of each 100 ms period, or max', () => {
  expect(formatCpuMax(null)).toBe('max 100000');
  expect(formatCpuMax(1.5)).toBe('150000 100000');
  expect(formatCpuMax(0.1)).toBe('10000 100000');
});

test('it reads usage and throttled time from cpu.stat', () => {
  const stat = 'usage_usec 1029646\nuser_usec 1025746\nnr_throttled 20\nthrottled_usec 970041\n';

  expect(parseCpuStat(stat)).toEqual({ usageUsec: 1_029_646, throttledUsec: 970_041 });
  expect(parseCpuStat('')).toBeNull();
});

test('a VM gets its limit and weight, no limit while a snapshot is made, then its own again', () => {
  using ctx = setupCgroups();

  const cgroup = ctx.cgroups.setup('a', { limit: 0.5, weight: 200 });

  expect(cgroup?.procsPath).toBe(join(ctx.root, 'imps', 'a', 'cgroup.procs'));
  expect(ctx.readFile('a', 'cpu.max')).toBe('50000 100000');
  expect(ctx.readFile('a', 'cpu.weight')).toBe('200');
  cgroup?.liftLimit();
  expect(ctx.readFile('a', 'cpu.max')).toBe('max 100000');
  cgroup?.applyLimit();
  expect(ctx.readFile('a', 'cpu.max')).toBe('50000 100000');

  ctx.cgroups.apply('a', { limit: null, weight: 50 });

  expect(ctx.readFile('a', 'cpu.max')).toBe('max 100000');
  expect(ctx.readFile('a', 'cpu.weight')).toBe('50');
});

test('without the cpu controller handed down, limits are kept and nothing is written', () => {
  using ctx = setupCgroups(false);

  expect(ctx.cgroups.isEnforced).toBeFalse();
  expect(ctx.cgroups.setup('a', { limit: 1, weight: 100 })).toBeNull();
  expect(existsSync(join(ctx.root, 'imps', 'a'))).toBeFalse();
  expect(ctx.cgroups.removeOrphans(new Set())).toEqual([]);
});

test('a re-adopted VM joins its cgroup only when it is elsewhere', () => {
  using ctx = setupCgroups();

  ctx.setProcessCgroup(10, '/init');
  ctx.cgroups.adopt('a', 10, { limit: 1, weight: 100 });

  expect(ctx.readFile('a', 'cgroup.procs')).toBe('10');

  ctx.setProcessCgroup(11, '/imps/b');
  ctx.cgroups.adopt('b', 11, { limit: 1, weight: 100 });

  expect(existsSync(join(ctx.root, 'imps', 'b'))).toBeFalse();
});

test('remove and the orphan sweep take empty cgroups; a failed rmdir is logged', async () => {
  using ctx = setupCgroups();

  ctx.cgroups.setup('kept', { limit: null, weight: 100 });
  ctx.cgroups.setup('gone', { limit: null, weight: 100 });

  mkdirSync(join(ctx.root, 'imps', 'orphan'));

  // the kernel's files are not in a temp dir; an empty cgroup is an empty dir
  for (const impId of ['kept', 'gone']) {
    for (const file of ['cpu.max', 'cpu.weight']) {
      rmSync(join(ctx.root, 'imps', impId, file));
    }
  }

  await ctx.cgroups.remove('gone');
  await ctx.cgroups.remove('never-made');

  expect(existsSync(join(ctx.root, 'imps', 'gone'))).toBeFalse();
  expect(ctx.cgroups.removeOrphans(new Set(['kept']))).toEqual(['orphan']);
  expect(existsSync(join(ctx.root, 'imps', 'kept'))).toBeTrue();

  // a cgroup that still holds files stands for one that still holds a VM
  ctx.cgroups.setup('busy', { limit: null, weight: 100 });

  await ctx.cgroups.remove('busy');

  expect(ctx.logs).toHaveLength(1);
  expect(ctx.logs[0]).toStartWith('impd: cgroup busy: remove:');
});
