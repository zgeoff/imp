import { expect, mock, onTestFinished, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import {
  buildMemoryMax,
  createCpuCgroups,
  formatCpuMax,
  parseCpuStat,
  parseOomKills,
} from './cpu-cgroups';

// A cgroup root with its imps/ cgroup and a /proc, in a temp dir; what
// setup-cgroups.sh hands down to imps/ is the test's to write.
function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-cgroups-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const root = join(dir, 'cgroup');
  const proc = join(dir, 'proc');

  mkdirSync(join(root, 'imps'), { recursive: true });
  mkdirSync(proc);

  const logs: string[] = [];

  return {
    root,
    proc,
    logs,
    log: (message: string) => {
      logs.push(message);
    },
  };
}

test.each([
  ['no limit', null, 'max 100000'],
  ['1.5 CPUs', 1.5, '150000 100000'],
  ['0.1 CPUs', 0.1, '10000 100000'],
])('#formatCpuMax writes %s as microseconds of each 100 ms period', (_label, limit, cpuMax) => {
  expect(formatCpuMax(limit)).toBe(cpuMax);
});

test('#parseCpuStat reads usage and throttled time from cpu.stat', () => {
  expect(
    parseCpuStat('usage_usec 1029646\nuser_usec 1025746\nnr_throttled 20\nthrottled_usec 970041\n'),
  ).toStrictEqual({ usageUsec: 1_029_646, throttledUsec: 970_041 });
});

test('#parseCpuStat reads nothing from an empty cpu.stat', () => {
  expect(parseCpuStat('')).toBeNull();
});

test.each([
  ['a 512 MiB guest 256 MiB more', 512, 768],
  ['a 2 GiB guest 256 MiB more', 2048, 2304],
  ['an 8 GiB guest an eighth more', 8192, 9216],
])('#buildMemoryMax allows %s', (_label, memoryMib, maxMib) => {
  expect(buildMemoryMax(memoryMib)).toBe(String(maxMib * 1024 * 1024));
});

test('#parseOomKills reads oom_kill from memory.events', () => {
  expect(parseOomKills('oom 0\noom_kill 2\noom_group_kill 1\n')).toBe(2);
});

test('#parseOomKills reads nothing from an empty memory.events', () => {
  expect(parseOomKills('')).toBeNull();
});

test('#setup gives a VM a cgroup with its CPU limit and weight', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });
  const cgroup = cgroups.setup('a', { limit: 0.5, weight: 200 }, 512);

  expect(cgroup?.procsPath).toBe(join(ctx.root, 'imps', 'a', 'cgroup.procs'));
  expect(readFileSync(join(ctx.root, 'imps', 'a', 'cpu.max'), 'utf8')).toBe('50000 100000');
  expect(readFileSync(join(ctx.root, 'imps', 'a', 'cpu.weight'), 'utf8')).toBe('200');
});

test('#liftLimit lifts the CPU limit while a snapshot is made', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });
  const cgroup = cgroups.setup('a', { limit: 0.5, weight: 200 }, 512);

  invariant(cgroup);

  cgroup.liftLimit();

  expect(readFileSync(join(ctx.root, 'imps', 'a', 'cpu.max'), 'utf8')).toBe('max 100000');
});

test('#applyLimit puts the CPU limit back after a snapshot', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });
  const cgroup = cgroups.setup('a', { limit: 0.5, weight: 200 }, 512);

  invariant(cgroup);

  cgroup.liftLimit();
  cgroup.applyLimit();

  expect(readFileSync(join(ctx.root, 'imps', 'a', 'cpu.max'), 'utf8')).toBe('50000 100000');
});

test('#apply changes the CPU limit and weight of a running VM', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  cgroups.setup('a', { limit: 0.5, weight: 200 }, 512);
  cgroups.apply('a', { limit: null, weight: 50 });

  expect(readFileSync(join(ctx.root, 'imps', 'a', 'cpu.max'), 'utf8')).toBe('max 100000');
  expect(readFileSync(join(ctx.root, 'imps', 'a', 'cpu.weight'), 'utf8')).toBe('50');
});

test('#setup writes nothing when the cpu controller is not handed down', () => {
  const ctx = setupTest();
  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });
  const cgroup = cgroups.setup('a', { limit: 1, weight: 100 }, 512);

  expect(cgroups.isEnforced).toBeFalse();
  expect(cgroup).toBeNull();
  expect(existsSync(join(ctx.root, 'imps', 'a'))).toBeFalse();
});

test('#removeOrphans finds nothing to sweep when the cpu controller is not handed down', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.root, 'imps', 'orphan'));

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  expect(cgroups.removeOrphans(new Set())).toStrictEqual([]);
});

test('#adopt moves a re-adopted VM that is elsewhere into its cgroup', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu\n');
  mkdirSync(join(ctx.proc, '10'));
  writeFileSync(join(ctx.proc, '10', 'cgroup'), '0::/init\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  cgroups.adopt('a', 10, { limit: 1, weight: 100 }, 512);

  expect(readFileSync(join(ctx.root, 'imps', 'a', 'cgroup.procs'), 'utf8')).toBe('10');
});

test('#adopt leaves a re-adopted VM that is already in its cgroup', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu\n');
  mkdirSync(join(ctx.proc, '11'));
  writeFileSync(join(ctx.proc, '11', 'cgroup'), '0::/imps/b\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  cgroups.adopt('b', 11, { limit: 1, weight: 100 }, 512);

  expect(existsSync(join(ctx.root, 'imps', 'b'))).toBeFalse();
});

test('#remove takes an empty cgroup', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  cgroups.setup('gone', { limit: null, weight: 100 }, 512);

  // the kernel's files are not in a temp dir; an empty cgroup is an empty dir
  rmSync(join(ctx.root, 'imps', 'gone', 'cpu.max'));
  rmSync(join(ctx.root, 'imps', 'gone', 'cpu.weight'));

  await cgroups.remove('gone');

  expect(existsSync(join(ctx.root, 'imps', 'gone'))).toBeFalse();
  expect(ctx.logs).toStrictEqual([]);
});

test('#remove does nothing for a cgroup it never made', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  await cgroups.remove('never-made');

  expect(ctx.logs).toStrictEqual([]);
});

test('#remove logs a cgroup that still holds a VM and keeps it', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  // a cgroup that still holds files stands for one that still holds a VM
  cgroups.setup('busy', { limit: null, weight: 100 }, 512);

  await cgroups.remove('busy');

  expect(ctx.logs).toHaveLength(1);
  expect(ctx.logs[0]).toStartWith('impd: cgroup busy: remove:');
  expect(existsSync(join(ctx.root, 'imps', 'busy'))).toBeTrue();
});

test('#remove tries a busy cgroup again until the kernel lets it go', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu\n');

  const sleeps: number[] = [];

  // the first rmdir finds the exited VM still held, as the kernel answers
  const rmdir = mock(rmdirSync).mockImplementationOnce(() => {
    throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' });
  });

  const cgroups = createCpuCgroups({
    root: ctx.root,
    procRoot: ctx.proc,
    log: ctx.log,
    rmdir,
    sleep: (ms) => {
      sleeps.push(ms);

      return Promise.resolve();
    },
  });

  mkdirSync(join(ctx.root, 'imps', 'held'));

  await cgroups.remove('held');

  expect(existsSync(join(ctx.root, 'imps', 'held'))).toBeFalse();
  expect(sleeps).toStrictEqual([50]);
  expect(ctx.logs).toStrictEqual([]);
});

test('#remove logs a cgroup that stays busy past the last try and keeps it', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu\n');

  const sleeps: number[] = [];

  const cgroups = createCpuCgroups({
    root: ctx.root,
    procRoot: ctx.proc,
    log: ctx.log,
    rmdir: () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' });
    },
    sleep: (ms) => {
      sleeps.push(ms);

      return Promise.resolve();
    },
  });

  mkdirSync(join(ctx.root, 'imps', 'held'));

  await cgroups.remove('held');

  // 40 tries, with a 50 ms wait between each two
  expect(sleeps).toHaveLength(39);

  expect(ctx.logs).toStrictEqual([
    'impd: cgroup held: remove: EBUSY: resource busy or locked, rmdir',
  ]);

  expect(existsSync(join(ctx.root, 'imps', 'held'))).toBeTrue();
});

test('#removeOrphans takes the empty cgroups of imps it does not know', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu\n');
  mkdirSync(join(ctx.root, 'imps', 'orphan'));

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });
  const removed = cgroups.removeOrphans(new Set(['kept']));

  expect(removed).toStrictEqual(['orphan']);
  expect(existsSync(join(ctx.root, 'imps', 'orphan'))).toBeFalse();
});

test('#removeOrphans never takes the cgroup of an imp it knows', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu\n');
  mkdirSync(join(ctx.root, 'imps', 'kept'));

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  cgroups.removeOrphans(new Set(['kept']));

  expect(existsSync(join(ctx.root, 'imps', 'kept'))).toBeTrue();
});

test('#setup lets a VM use its memory and 256 MiB more, never swap, and die whole', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  cgroups.setup('a', { limit: null, weight: 100 }, 1024);

  expect(cgroups.isMemoryEnforced).toBeTrue();

  expect(readFileSync(join(ctx.root, 'imps', 'a', 'memory.max'), 'utf8')).toBe(
    String(1280 * 1024 * 1024),
  );

  expect(readFileSync(join(ctx.root, 'imps', 'a', 'memory.high'), 'utf8')).toBe('max');
  expect(readFileSync(join(ctx.root, 'imps', 'a', 'memory.swap.max'), 'utf8')).toBe('0');
  expect(readFileSync(join(ctx.root, 'imps', 'a', 'memory.oom.group'), 'utf8')).toBe('1');
});

test('#liftLimit keeps memory.max while a snapshot is made', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });
  const cgroup = cgroups.setup('a', { limit: null, weight: 100 }, 1024);

  invariant(cgroup);

  cgroup.liftLimit();

  expect(readFileSync(join(ctx.root, 'imps', 'a', 'memory.max'), 'utf8')).toBe(
    String(1280 * 1024 * 1024),
  );
});

test('#setup writes only the CPU settings without the memory controller', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  cgroups.setup('a', { limit: null, weight: 100 }, 1024);

  expect(cgroups.isMemoryEnforced).toBeFalse();
  expect(existsSync(join(ctx.root, 'imps', 'a', 'memory.max'))).toBeFalse();
});

test('#readOomKills reads the OOM kills of a VM cgroup', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  cgroups.setup('a', { limit: null, weight: 100 }, 1024);

  writeFileSync(
    join(ctx.root, 'imps', 'a', 'memory.events'),
    'low 0\nhigh 3\nmax 1\noom 1\noom_kill 1\n',
  );

  expect(cgroups.readOomKills('a')).toBe(1);
});

test('#readOomKills reads nothing for a cgroup it never made', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  expect(cgroups.readOomKills('never-made')).toBeNull();
});

test('#hasOomKillSinceStart counts no kill an older VM left in a kept cgroup', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  // a cgroup a busy remove kept, with an older VM's kill in it
  mkdirSync(join(ctx.root, 'imps', 'a'));
  writeFileSync(join(ctx.root, 'imps', 'a', 'memory.events'), 'oom 1\noom_kill 1\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  cgroups.setup('a', { limit: null, weight: 100 }, 1024);

  expect(cgroups.hasOomKillSinceStart('a')).toBeFalse();
});

test('#hasOomKillSinceStart counts no kill before the VM starts', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');
  mkdirSync(join(ctx.root, 'imps', 'a'));
  writeFileSync(join(ctx.root, 'imps', 'a', 'memory.events'), 'oom 1\noom_kill 1\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  expect(cgroups.hasOomKillSinceStart('a')).toBeFalse();
});

test('#hasOomKillSinceStart counts a kill that rose after the VM started', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');
  mkdirSync(join(ctx.root, 'imps', 'a'));
  writeFileSync(join(ctx.root, 'imps', 'a', 'memory.events'), 'oom 1\noom_kill 1\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  cgroups.setup('a', { limit: null, weight: 100 }, 1024);

  writeFileSync(join(ctx.root, 'imps', 'a', 'memory.events'), 'oom 2\noom_kill 2\n');

  expect(cgroups.hasOomKillSinceStart('a')).toBeTrue();
});

test('#hasOomKillSinceStart counts from the adopt for a re-adopted VM in its cgroup', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');
  mkdirSync(join(ctx.root, 'imps', 'a'));
  writeFileSync(join(ctx.root, 'imps', 'a', 'memory.events'), 'oom 2\noom_kill 2\n');
  mkdirSync(join(ctx.proc, '10'));
  writeFileSync(join(ctx.proc, '10', 'cgroup'), '0::/imps/a\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  cgroups.adopt('a', 10, { limit: null, weight: 100 }, 1024);

  expect(cgroups.hasOomKillSinceStart('a')).toBeFalse();
});

test('#setGuestMib raises memory.max for a hot-plug', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  cgroups.setup('a', { limit: null, weight: 100 }, 1024);
  cgroups.setGuestMib('a', 4096);

  expect(readFileSync(join(ctx.root, 'imps', 'a', 'memory.max'), 'utf8')).toBe(
    String(4608 * 1024 * 1024),
  );
});

test('#setGuestMib lowers memory.max for an unplug', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  cgroups.setup('a', { limit: null, weight: 100 }, 1024);
  cgroups.setGuestMib('a', 4096);
  cgroups.setGuestMib('a', 1536);

  expect(readFileSync(join(ctx.root, 'imps', 'a', 'memory.max'), 'utf8')).toBe(
    String(1792 * 1024 * 1024),
  );
});

test('#setup keeps a hot-plugged size across a sleep', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  cgroups.setup('a', { limit: null, weight: 100 }, 1024);
  cgroups.setGuestMib('a', 1536);
  cgroups.setup('a', { limit: null, weight: 100 }, 1024);

  expect(readFileSync(join(ctx.root, 'imps', 'a', 'memory.max'), 'utf8')).toBe(
    String(1792 * 1024 * 1024),
  );
});

test('#setGuestMib makes no cgroup for an imp without one', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  cgroups.setGuestMib('b', 512);

  expect(existsSync(join(ctx.root, 'imps', 'b'))).toBeFalse();
});

test('#setup takes a size set before the cgroup was made', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  cgroups.setGuestMib('b', 512);
  cgroups.setup('b', { limit: null, weight: 100 }, 1024);

  expect(readFileSync(join(ctx.root, 'imps', 'b', 'memory.max'), 'utf8')).toBe(
    String(768 * 1024 * 1024),
  );
});

test('#remove forgets a hot-plugged size, so the next start gets its memory', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const cgroups = createCpuCgroups({ root: ctx.root, procRoot: ctx.proc, log: ctx.log });

  cgroups.setup('a', { limit: null, weight: 100 }, 1024);
  cgroups.setGuestMib('a', 2048);

  await cgroups.remove('a');

  cgroups.setup('a', { limit: null, weight: 100 }, 1024);

  expect(readFileSync(join(ctx.root, 'imps', 'a', 'memory.max'), 'utf8')).toBe(
    String(1280 * 1024 * 1024),
  );
});
