import { expect, onTestFinished, test } from 'bun:test';
import { buildStubCpuCgroups } from '../test-utils/build-stub-cpu-cgroups';
import { OOM_KILL_TRIGGER, startOomWatch } from './oom-kill';
import { createImpTest } from './test-imps';
import type { ImpTestOptions } from './test-imps';

async function setupTest(options: ImpTestOptions = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack, options);

  // the image every imp boots from
  await harness.createTestImage('ubuntu');

  return harness;
}

test('#startOomWatch sees an OOM kill counted after it started', () => {
  const stub = buildStubCpuCgroups({ isMemoryEnforced: true });

  stub.cgroups.setup('a', { limit: null, weight: 100 }, 512);
  stub.oomKills.set('a', 2);

  const hasOomKill = startOomWatch(stub.cgroups, 'a');

  stub.oomKills.set('a', 3);

  expect(hasOomKill()).toBeTrue();
});

test('#startOomWatch ignores an OOM kill counted before it started', () => {
  const stub = buildStubCpuCgroups({ isMemoryEnforced: true });

  stub.cgroups.setup('a', { limit: null, weight: 100 }, 512);
  stub.oomKills.set('a', 2);

  const hasOomKill = startOomWatch(stub.cgroups, 'a');

  expect(hasOomKill()).toBeFalse();
});

test('#startOomWatch sees no OOM kill for an imp without a cgroup', () => {
  const stub = buildStubCpuCgroups({ isMemoryEnforced: true });
  const hasOomKill = startOomWatch(stub.cgroups, 'a');

  stub.oomKills.set('a', 1);

  expect(hasOomKill()).toBeFalse();
});

test('#sleepImp says a sleep the memory limit cut short failed for that reason', async () => {
  const stub = buildStubCpuCgroups({ isMemoryEnforced: true });

  const ctx = await setupTest({ cgroups: stub.cgroups });
  const imp = await ctx.imps.createImp({ name: 'dev' });

  // kills from before the sleep, which do not count
  stub.oomKills.set(imp.id, 3);
  ctx.fake.queue('sleep', 'die');

  const held = ctx.fake.hold('sleep');
  const sleeping = ctx.imps.sleepImp('dev');

  await held.reached;

  stub.oomKills.set(imp.id, 4);
  held.release();

  expect(sleeping).rejects.toThrowWithMessage(Error, `sleep failed: ${OOM_KILL_TRIGGER}`);

  const found = await ctx.imps.getImp('dev');

  expect(found.state).toBe('stopped');
  expect(found.error).toBe(OOM_KILL_TRIGGER);

  expect(ctx.logs).toSatisfyAny((line: string) =>
    line.includes(`sleep failed after firecracker stopped: ${OOM_KILL_TRIGGER}`),
  );
});

test('#wakeImp boots cold after a wake the memory limit cut short, and says why', async () => {
  const stub = buildStubCpuCgroups({ isMemoryEnforced: true });

  const ctx = await setupTest({ cgroups: stub.cgroups });
  const imp = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.sleepImp('dev');

  ctx.fake.queue('wake', 'fail');

  const held = ctx.fake.hold('wake');
  const waking = ctx.imps.wakeImp('dev');

  await held.reached;

  stub.oomKills.set(imp.id, 1);
  held.release();

  const woken = await waking;

  expect(woken.state).toBe('running');

  expect(ctx.logs).toSatisfyAny((line: string) =>
    line.includes(`wake failed: ${OOM_KILL_TRIGGER}; booting cold`),
  );
});

test('#wakeImp does not blame a failed wake on an OOM kill from before it', async () => {
  const stub = buildStubCpuCgroups({ isMemoryEnforced: true });

  const ctx = await setupTest({ cgroups: stub.cgroups });
  const imp = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.sleepImp('dev');

  // a kill from before the wake
  stub.oomKills.set(imp.id, 1);
  ctx.fake.queue('wake', 'fail');

  const woken = await ctx.imps.wakeImp('dev');

  expect(woken.state).toBe('running');
  expect(ctx.logs).toSatisfyAll((line: string) => !line.includes(OOM_KILL_TRIGGER));
});

test('#sleepImp does not blame a lost sleep on an OOM kill from before it', async () => {
  const stub = buildStubCpuCgroups({ isMemoryEnforced: true });

  const ctx = await setupTest({ cgroups: stub.cgroups });
  const imp = await ctx.imps.createImp({ name: 'dev' });

  // a kill from before the sleep
  stub.oomKills.set(imp.id, 1);
  ctx.fake.queue('sleep', 'die');

  const sleeping = ctx.imps.sleepImp('dev');

  expect(sleeping).rejects.toThrowWithMessage(Error, 'snapshot files lost after the kill');

  const found = await ctx.imps.getImp('dev');

  expect(found.error).toBeUndefined();
  expect(ctx.logs).toSatisfyAll((line: string) => !line.includes(OOM_KILL_TRIGGER));
});
