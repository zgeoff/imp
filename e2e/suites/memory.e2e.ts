import { expect, onTestFinished, test } from 'bun:test';
import { invariant } from '@impz/test-utils/invariant';
import { readBalloonStats } from '../lib/balloon-stats';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { readMemAvailableMib, readMemTotalMib, readPluggedMib } from '../lib/guest-memory';
import { createInstanceClient, requireImp, runImp, runShellInImp } from '../lib/imp-cli';
import { findAsleepLine } from '../lib/impd-sleep-log';
import { holdImp, waitForExec } from '../lib/imps';
import { readImpdLogSince } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// Elastic memory (docs/architecture/lifecycle/elastic-memory.md): a 256 MiB guest that may grow
// to 1 GiB, which stays the most this suite boots. One imp grows, shrinks,
// then sleeps and wakes, each step on what the one before it left plugged.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('memory'), stack, client };
}

test('it grows an elastic guest under a gradual allocation, shrinks it once the memory is freed, and unplugs the spare before a sleep whose wake works', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}grow`;

  await runImp(
    'new',
    name,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '256',
    '--max-memory',
    '1024',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const row = await requireImp(name);
  const totalBefore = await readMemTotalMib(name);

  // 600 MiB in tmpfs, which nothing can reclaim, at 30 MiB a second: the
  // `sleep 1` sets that rate, which the controller's margin covers; a faster
  // burst can outrun it
  const fillStarted = performance.now();

  const filled = await runShellInImp(
    name,
    'mkdir -p /mnt/fill && mount -t tmpfs -o size=900m tmpfs /mnt/fill && ' +
      'i=0; while [ $i -lt 20 ]; do dd if=/dev/zero of=/mnt/fill/$i bs=1M count=30 2>/dev/null || exit 1; i=$((i+1)); sleep 1; done; echo filled',
  );

  writeMetric('memory_fill_600_mib_ms', Math.round(performance.now() - fillStarted));

  const totalGrown = await readMemTotalMib(name);
  const pluggedGrown = await readPluggedMib(name);
  const listed = await runImp('ls');

  expect(filled.trim()).toBe('filled');
  expect(totalGrown - totalBefore).toBeGreaterThanOrEqual(400);
  expect(pluggedGrown).toBeGreaterThanOrEqual(512);
  expect(listed).toMatch(new RegExp(`${name}.*\\d+/1024 MiB`, 'u'));

  await runShellInImp(name, 'rm -f /mnt/fill/*');

  // What a shrink may leave plugged in an idle guest: its use (about 40 MiB)
  // and a step past its grow mark (424 MiB in all), less the base it sees
  // (about 236 of its 256 MiB), is about 188, so at most 256.
  const shrinkStarted = performance.now();

  await waitFor(
    `${name} to unplug to its spare size`,
    async () => {
      const pluggedMib = await readPluggedMib(name);

      if (pluggedMib > 256) {
        throw new Error(`${String(pluggedMib)} MiB still plugged`);
      }
    },
    { timeoutMs: 90_000, intervalMs: 1000 },
  );

  writeMetric('memory_shrink_after_free_ms', Math.round(performance.now() - shrinkStarted));

  const totalShrunk = await readMemTotalMib(name);

  expect(totalShrunk).toBeLessThan(256 + 256);

  // 300 MiB in use at 30 MiB a second, too soon for the minute-long idle
  // shrink. It crosses the grow mark only near its end, so the memory stays
  // in use until the grow lands, then goes
  const secondFillStarted = new Date();

  await runShellInImp(
    name,
    'i=0; while [ $i -lt 10 ]; do dd if=/dev/zero of=/mnt/fill/$i bs=1M count=30 2>/dev/null; i=$((i+1)); sleep 1; done',
  );

  const growStarted = performance.now();

  await waitFor(
    `${name} to grow under the second fill`,
    async () => {
      const pluggedMib = await readPluggedMib(name);

      if (pluggedMib < 256) {
        throw new Error(`${String(pluggedMib)} MiB plugged`);
      }
    },
    { timeoutMs: 30_000, intervalMs: 200 },
  );

  writeMetric('memory_grow_after_fill_ms', Math.round(performance.now() - growStarted));

  // Once the balloon statistics count what the guest holds, a tick that read
  // them from before the grow has run: one step covers this fill, so a
  // second grow is one those older statistics asked for
  await waitFor(
    `the balloon statistics of ${name} to show the grow`,
    async () => {
      const stats = await readBalloonStats(row.id);
      const totalMib = await readMemTotalMib(name);

      if (Math.abs(stats.totalMib - totalMib) > 2) {
        throw new Error(
          `${String(stats.totalMib)} MiB in the statistics, the guest has ${String(totalMib)}`,
        );
      }
    },
    { timeoutMs: 10_000, intervalMs: 200 },
  );

  await runShellInImp(name, 'rm -f /mnt/fill/*');

  const pluggedBeforeSleep = await readPluggedMib(name);
  const availableInGuest = await readMemAvailableMib(name);

  // the sleep sizes its unplug from the balloon statistics, which lag the
  // guest; it must see the freed 300 MiB (64 MiB covers the guest's own churn)
  await waitFor(
    `the balloon statistics of ${name} to show the freed memory`,
    async () => {
      const stats = await readBalloonStats(row.id);

      if (stats.availableMib < availableInGuest - 64) {
        throw new Error(
          `${String(stats.availableMib)} MiB available, the guest has ${String(availableInGuest)}`,
        );
      }
    },
    { timeoutMs: 10_000, intervalMs: 200 },
  );

  // a poll or more after the statistics counted the grow, so a tick that
  // read them from before it has logged its grow by now
  const secondFillLog = await readImpdLogSince(secondFillStarted);

  const grows = secondFillLog
    .split('\n')
    .filter((line) => line.includes(`${name}: memory low`) && line.includes('grew to'));

  expect(grows).toHaveLength(1);
  expect(pluggedBeforeSleep).toBeGreaterThanOrEqual(256);

  await runImp('hold', name, '0');

  const sleepStarted = new Date();

  await runImp('sleep', name);

  const sleepLog = await readImpdLogSince(sleepStarted);

  const slept = findAsleepLine(sleepLog, name);

  invariant(slept);
  writeMetric('memory_sleep_after_unplug_ms', slept.ms);

  // the sleep unplugged down to use and headroom before the pause
  expect(slept.pluggedMib).toBeLessThan(pluggedBeforeSleep);
  expect(slept.pluggedMib).toBeLessThanOrEqual(256);

  // an exec wakes it: the wake restores what the snapshot kept, and the guest
  // answers
  const wakeStarted = new Date();

  const totalAfterWake = await readMemTotalMib(name);
  const wakeLog = await readImpdLogSince(wakeStarted);

  expect(totalAfterWake).toBeLessThan(256 + 256);

  // from the snapshot, not a cold boot that would pass the same checks
  expect(wakeLog).toContain(`${name}: woke pid`);
  expect(wakeLog).not.toContain(`${name}: cold boot instead of a wake`);
}, 300_000);
