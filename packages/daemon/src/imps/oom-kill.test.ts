import { expect, test } from 'bun:test';
import { readRejection } from '../read-rejection';
import type { CpuCgroups } from '../vmm/cpu-cgroups';
import { OOM_KILL_TRIGGER } from './oom-kill';
import { setupImpTest } from './test-imps';

interface OomKillCount {
  count: number;
}

// cgroups whose memory.events counts `kills.count` OOM kills
function buildOomCgroups(kills: Readonly<OomKillCount>): CpuCgroups {
  return {
    isEnforced: true,
    isMemoryEnforced: true,
    readOomKills: () => kills.count,
    hasOomKillSinceStart: () => false,
    setup: () => null,
    apply: () => {},
    adopt: () => {},
    remove: () => Promise.resolve(),
    setGuestMib: () => {},
    kill: () => {},
    removeOrphans: () => [],
    readCpuStat: () => null,
  };
}

test('a sleep the memory limit cut short says so', async () => {
  const kills: OomKillCount = { count: 3 };

  await using ctx = await setupImpTest({ cgroups: buildOomCgroups(kills) });

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });

  ctx.fake.queue('sleep', 'die');

  const held = ctx.fake.hold('sleep');
  const sleeping = readRejection(ctx.imps.sleepImp('dev'));

  await held.reached;

  kills.count += 1;

  held.release();

  const error = await sleeping;
  const found = await ctx.imps.getImp('dev');

  expect(error).toMatchObject({ message: `sleep failed: ${OOM_KILL_TRIGGER}` });
  expect(found.state).toBe('stopped');
  expect(found.error).toBe(OOM_KILL_TRIGGER);

  expect(ctx.logs.join('\n')).toContain(
    `sleep failed after firecracker stopped: ${OOM_KILL_TRIGGER}`,
  );
});

test('a wake the memory limit cut short says so, then boots cold', async () => {
  const kills: OomKillCount = { count: 0 };

  await using ctx = await setupImpTest({ cgroups: buildOomCgroups(kills) });

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });
  await ctx.imps.sleepImp('dev');

  ctx.fake.queue('wake', 'fail');

  const held = ctx.fake.hold('wake');
  const waking = ctx.imps.wakeImp('dev');

  await held.reached;

  kills.count += 1;

  held.release();

  const woken = await waking;

  expect(woken.state).toBe('running');
  expect(ctx.logs.join('\n')).toContain(`wake failed: ${OOM_KILL_TRIGGER}; booting cold`);
});

test('an OOM kill from before the sleep or the wake is not this failure', async () => {
  await using ctx = await setupImpTest({ cgroups: buildOomCgroups({ count: 1 }) });

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });
  await ctx.imps.sleepImp('dev');

  ctx.fake.queue('wake', 'fail');

  await ctx.imps.wakeImp('dev');

  ctx.fake.queue('sleep', 'die');

  const error = await readRejection(ctx.imps.sleepImp('dev'));
  const found = await ctx.imps.getImp('dev');

  expect(error).toMatchObject({ message: 'snapshot files lost after the kill' });
  expect(found.error).toBeUndefined();
  expect(ctx.logs.join('\n')).not.toContain(OOM_KILL_TRIGGER);
});
