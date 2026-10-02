import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMemoryMax,
  createCpuCgroups,
  formatCpuMax,
  parseCpuStat,
  parseOomKills,
} from './cpu-cgroups';

// a cgroup root and a /proc in a temp dir, with `controllers` handed to
// imps/, as setup-cgroups.sh leaves it; none when `delegated` is false
function setupCgroups(delegated = true, controllers = 'cpu') {
  const dir = mkdtempSync(join(tmpdir(), 'imp-cgroups-'));
  const root = join(dir, 'cgroup');
  const proc = join(dir, 'proc');
  const logs: string[] = [];

  mkdirSync(join(root, 'imps'), { recursive: true });
  mkdirSync(proc);

  if (delegated) {
    writeFileSync(join(root, 'imps', 'cgroup.subtree_control'), `${controllers}\n`);
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

  const cgroup = ctx.cgroups.setup('a', { limit: 0.5, weight: 200 }, 512);

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
  expect(ctx.cgroups.setup('a', { limit: 1, weight: 100 }, 512)).toBeNull();
  expect(existsSync(join(ctx.root, 'imps', 'a'))).toBeFalse();
  expect(ctx.cgroups.removeOrphans(new Set())).toEqual([]);
});

test('a re-adopted VM joins its cgroup only when it is elsewhere', () => {
  using ctx = setupCgroups();

  ctx.setProcessCgroup(10, '/init');
  ctx.cgroups.adopt('a', 10, { limit: 1, weight: 100 }, 512);

  expect(ctx.readFile('a', 'cgroup.procs')).toBe('10');

  ctx.setProcessCgroup(11, '/imps/b');
  ctx.cgroups.adopt('b', 11, { limit: 1, weight: 100 }, 512);

  expect(existsSync(join(ctx.root, 'imps', 'b'))).toBeFalse();
});

test('remove and the orphan sweep take empty cgroups; a failed rmdir is logged', async () => {
  using ctx = setupCgroups();

  ctx.cgroups.setup('kept', { limit: null, weight: 100 }, 512);
  ctx.cgroups.setup('gone', { limit: null, weight: 100 }, 512);

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
  ctx.cgroups.setup('busy', { limit: null, weight: 100 }, 512);

  await ctx.cgroups.remove('busy');

  expect(ctx.logs).toHaveLength(1);
  expect(ctx.logs[0]).toStartWith('impd: cgroup busy: remove:');
});

test('a VM may use its memory and 256 MiB more, never swap, and dies whole', () => {
  using ctx = setupCgroups(true, 'cpu memory');

  const cgroup = ctx.cgroups.setup('a', { limit: null, weight: 100 }, 1024);

  expect(ctx.cgroups.isMemoryEnforced).toBeTrue();
  expect(ctx.readFile('a', 'memory.max')).toBe(String(1280 * 1024 * 1024));
  expect(ctx.readFile('a', 'memory.high')).toBe('max');
  expect(ctx.readFile('a', 'memory.swap.max')).toBe('0');
  expect(ctx.readFile('a', 'memory.oom.group')).toBe('1');

  // a sleep or a wake lifts the CPU limit only; memory.max always holds
  cgroup?.liftLimit();
  expect(ctx.readFile('a', 'memory.max')).toBe(String(1280 * 1024 * 1024));
  cgroup?.applyLimit();

  writeFileSync(
    join(ctx.root, 'imps', 'a', 'memory.events'),
    'low 0\nhigh 3\nmax 1\noom 1\noom_kill 1\n',
  );

  expect(ctx.cgroups.readOomKills('a')).toBe(1);
  expect(ctx.cgroups.readOomKills('never-made')).toBeNull();
});

test('an OOM kill counts for the VM that died only when it rose after its start', () => {
  using ctx = setupCgroups(true, 'cpu memory');

  const events = join(ctx.root, 'imps', 'a', 'memory.events');

  // a cgroup a busy remove kept, with an older VM's kill in it
  mkdirSync(join(ctx.root, 'imps', 'a'));
  writeFileSync(events, 'oom 1\noom_kill 1\n');

  expect(ctx.cgroups.hasOomKillSinceStart('a')).toBeFalse();

  ctx.cgroups.setup('a', { limit: null, weight: 100 }, 1024);

  expect(ctx.cgroups.hasOomKillSinceStart('a')).toBeFalse();

  writeFileSync(events, 'oom 2\noom_kill 2\n');

  expect(ctx.cgroups.hasOomKillSinceStart('a')).toBeTrue();

  // a re-adopted VM inside its cgroup counts from the adopt
  ctx.setProcessCgroup(10, '/imps/a');
  ctx.cgroups.adopt('a', 10, { limit: null, weight: 100 }, 1024);

  expect(ctx.cgroups.hasOomKillSinceStart('a')).toBeFalse();
});

test('a hot-plug moves the limit, and a sleep keeps the new size', () => {
  using ctx = setupCgroups(true, 'cpu memory');

  ctx.cgroups.setup('a', { limit: null, weight: 100 }, 1024);
  ctx.cgroups.setGuestMib('a', 4096);

  expect(ctx.readFile('a', 'memory.max')).toBe(String(4608 * 1024 * 1024));

  ctx.cgroups.setGuestMib('a', 1536);

  expect(ctx.readFile('a', 'memory.max')).toBe(String(1792 * 1024 * 1024));

  // a sleep's setup keeps the plugged size; a stop forgets it
  ctx.cgroups.setup('a', { limit: null, weight: 100 }, 1024);

  expect(ctx.readFile('a', 'memory.max')).toBe(String(1792 * 1024 * 1024));

  // no cgroup yet: the size waits for setup to make it
  ctx.cgroups.setGuestMib('b', 512);

  expect(existsSync(join(ctx.root, 'imps', 'b'))).toBeFalse();

  ctx.cgroups.setup('b', { limit: null, weight: 100 }, 1024);

  expect(ctx.readFile('b', 'memory.max')).toBe(String(768 * 1024 * 1024));
});

test('a stop forgets a hot-plugged size', async () => {
  using ctx = setupCgroups(true, 'cpu memory');

  ctx.cgroups.setup('a', { limit: null, weight: 100 }, 1024);
  ctx.cgroups.setGuestMib('a', 2048);

  await ctx.cgroups.remove('a');

  ctx.cgroups.setup('a', { limit: null, weight: 100 }, 1024);

  expect(ctx.readFile('a', 'memory.max')).toBe(String(1280 * 1024 * 1024));
});

test('without the memory controller, only the CPU settings are written', () => {
  using ctx = setupCgroups();

  ctx.cgroups.setup('a', { limit: null, weight: 100 }, 1024);

  expect(ctx.cgroups.isMemoryEnforced).toBeFalse();
  expect(existsSync(join(ctx.root, 'imps', 'a', 'memory.max'))).toBeFalse();
});

test('memory limits and oom_kill parse as the kernel writes them', () => {
  // 256 MiB of room up to a 2 GiB guest, an eighth of the guest above it
  expect(buildMemoryMax(512)).toBe(String(768 * 1024 * 1024));
  expect(buildMemoryMax(2048)).toBe(String(2304 * 1024 * 1024));
  expect(buildMemoryMax(8192)).toBe(String(9216 * 1024 * 1024));
  expect(parseOomKills('oom 0\noom_kill 2\noom_group_kill 1\n')).toBe(2);
  expect(parseOomKills('')).toBeNull();
});
