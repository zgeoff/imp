import { expect, test } from 'bun:test';
import { resolveImageName } from '../lib/fixtures';
import { requireImp, runImp, runShellInImp } from '../lib/imp-cli';
import { createImp, holdImp } from '../lib/imps';
import { readImpdLogTail } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// Elastic memory (docs/architecture/memory.md): a 256 MiB guest that may grow
// to 1 GiB, which stays the most this suite boots.

const prefix = setupSuite('memory');
const TINY = resolveImageName('e2e-tiny');
const imp = `${prefix}grow`;

// what a shrink may leave plugged in an idle guest: its use (about 40 MiB)
// and a step past its grow mark (424 MiB in all), less the base it sees
// (about 236 of its 256 MiB), is about 188
const SPARE_PLUGGED_MIB = 256;

// the guest's MemTotal in MiB
async function readMemTotalMib(name: string): Promise<number> {
  const stdout = await runShellInImp(
    name,
    "grep MemTotal /proc/meminfo | tr -s ' ' | cut -d' ' -f2",
  );

  return Math.round(Number(stdout.trim()) / 1024);
}

// an awake elastic imp always reports it: a missing field is a failure, not 0
async function readPluggedMib(name: string): Promise<number> {
  const row = await requireImp(name);

  if (row.pluggedMib === undefined) {
    throw new Error(`${name} reports no pluggedMib`);
  }

  return row.pluggedMib;
}

test('an elastic guest grows under a gradual allocation that its base could not hold', async () => {
  await createImp(imp, '--image', TINY, '--memory', '256', '--max-memory', '1024');
  await holdImp(imp);

  const before = await readMemTotalMib(imp);

  // 600 MiB in tmpfs, which nothing can reclaim, 30 MiB a second: the
  // controller's margin covers that pace, a faster burst can outrun it
  const started = performance.now();

  const filled = await runShellInImp(
    imp,
    'mkdir -p /mnt/fill && mount -t tmpfs -o size=900m tmpfs /mnt/fill && ' +
      'i=0; while [ $i -lt 20 ]; do dd if=/dev/zero of=/mnt/fill/$i bs=1M count=30 2>/dev/null || exit 1; i=$((i+1)); sleep 1; done; echo filled',
  );

  writeMetric('memory_fill_600_mib_ms', Math.round(performance.now() - started));

  const after = await readMemTotalMib(imp);
  const pluggedMib = await readPluggedMib(imp);

  expect(filled.trim()).toBe('filled');
  expect(after - before).toBeGreaterThanOrEqual(400);
  expect(pluggedMib).toBeGreaterThanOrEqual(512);

  const listed = await runImp('ls');

  expect(listed).toMatch(new RegExp(`${imp}.*\\d+/1024 MiB`));
}, 120_000);

test('a guest with memory to spare shrinks to its use and headroom within a minute or so', async () => {
  await runShellInImp(imp, 'rm -f /mnt/fill/*');

  const started = performance.now();

  await waitFor(
    'the guest to unplug',
    async () => {
      const pluggedMib = await readPluggedMib(imp);

      if (pluggedMib > SPARE_PLUGGED_MIB) {
        throw new Error(`${String(pluggedMib)} MiB still plugged`);
      }
    },
    { timeoutMs: 90_000, intervalMs: 1000 },
  );

  writeMetric('memory_shrink_after_free_ms', Math.round(performance.now() - started));

  const total = await readMemTotalMib(imp);

  expect(total).toBeLessThan(256 + SPARE_PLUGGED_MIB);
}, 120_000);

test('a sleep unplugs what the guest spares first, and the wake brings it back working', async () => {
  // 300 MiB in use, then freed: too soon for the minute-long idle shrink,
  // but past the balloon statistics' 1 s lag
  await runShellInImp(
    imp,
    'i=0; while [ $i -lt 10 ]; do dd if=/dev/zero of=/mnt/fill/$i bs=1M count=30 2>/dev/null; i=$((i+1)); sleep 1; done; rm -f /mnt/fill/*; sleep 3',
  );

  const pluggedBefore = await readPluggedMib(imp);

  expect(pluggedBefore).toBeGreaterThanOrEqual(256);

  await runImp('hold', imp, '0');
  await runImp('sleep', imp);

  const log = await readImpdLogTail(50);

  const slept = log.split('\n').findLast((line) => line.includes(`${imp}: asleep in`)) ?? '';

  // the sleep unplugged down to use and headroom before the pause
  const logged = /asleep in (?<ms>\d+)ms.*, (?<plugged>\d+) MiB plugged/.exec(slept)?.groups;

  expect(Number(logged?.['plugged'])).toBeLessThan(pluggedBefore);
  expect(Number(logged?.['plugged'])).toBeLessThanOrEqual(SPARE_PLUGGED_MIB);

  writeMetric('memory_sleep_after_unplug_ms', Number(logged?.['ms']));

  // the wake restores what the snapshot kept, and the guest answers
  const total = await readMemTotalMib(imp);

  expect(total).toBeLessThan(256 + SPARE_PLUGGED_MIB);

  // from the snapshot, not a cold boot that would pass the same checks
  const after = await readImpdLogTail(50);

  const woke = after.split(slept).at(-1) ?? '';

  expect(woke).toContain(`${imp}: woke pid`);
  expect(woke).not.toContain(`${imp}: cold boot instead of a wake`);
}, 120_000);
