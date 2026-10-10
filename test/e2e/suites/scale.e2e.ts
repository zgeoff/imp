import { expect, onTestFinished, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { loadConfig } from '../../../packages/daemon/src/config';
import { ENFORCE_INTERVAL_MS } from '../../../packages/daemon/src/governor/ram-governor';
import { findOvershoots } from '../lib/budget-overshoot';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { getThroughProxy } from '../lib/http';
import {
  createInstanceClient,
  findImp,
  listImps,
  readInfo,
  readState,
  runImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import {
  buildFillScript,
  buildOvershootLimits,
  findBudgetViolations,
  readOvershootMs,
  readPerImpMib,
  startBudgetMonitor,
  waitForSampleAfter,
  waitForUnderBudget,
} from '../lib/scale-budget';
import { buildStats } from '../lib/stats';
import { readSuitePrefix } from '../lib/suites';
import { writeMetric } from '../lib/write-metric';

// The RAM governor at scale (docs/guides/development.md): more imps than the
// budget holds, each with a tmpfs of random data, so the governor must sleep
// the least recently active to admit the next.

// one stack for every release, so the monitor stops and the holds go before
// the imps they name
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('scale'), stack, client };
}

test(`it keeps ${String(config.scaleCount)} imps inside the RAM budget, sleeps the least recently active, and wakes each on request`, async () => {
  const ctx = await setupTest();

  // the suite's settings: the governor, not the idle timeout, sleeps imps
  const start = await readInfo();

  expect(start.ramBudgetMib).toBe(config.ramBudgetMib);
  expect(config.scaleMemoryMib * 2).toBeLessThanOrEqual(config.ramBudgetMib);

  // read at run time: the ksm suite changes IMP_BOOT_RESERVE_PERCENT
  const limits = buildOvershootLimits({
    budgetMib: config.ramBudgetMib,
    memoryMib: config.scaleMemoryMib,
    reservePercent: loadConfig({
      IMP_BOOT_RESERVE_PERCENT: process.env['IMP_BOOT_RESERVE_PERCENT'],
    }).bootReservePercent,
    enforceIntervalMs: ENFORCE_INTERVAL_MS,
  });

  const monitor = await startBudgetMonitor();

  ctx.stack.defer(() => monitor.stop());

  // No removal for the fleet: run-suites.ts keeps it for restart, per GEO-135
  // decision 1 ("the ordered full-acceptance scale/restart dependency"), and
  // resets it when restart does not follow.
  const names = Array.from(
    { length: config.scaleCount },
    (_, index) => `${ctx.prefix}${String(index + 1).padStart(2, '0')}`,
  );

  const createMs: number[] = [];

  // two imps before the measure: the second restores from the boot template
  // that the first built
  const measured = names.slice(0, Math.min(2, config.scaleCount));

  for (const name of measured) {
    const started = Date.now();

    await runImp(
      'new',
      name,
      '--image',
      resolveImageName('e2e-tiny'),
      '--memory',
      String(config.scaleMemoryMib),
    );

    createMs.push(Date.now() - started);

    await waitForExec(name);
    await runShellInImp(name, buildFillScript(config.scaleFillMib));
  }

  const perImp = await readPerImpMib(measured);

  const fit = Math.floor(config.ramBudgetMib / perImp);

  console.log(
    `    per-imp RAM ${String(perImp)} MiB (--memory ${String(config.scaleMemoryMib)}, ` +
      `${String(config.scaleFillMib)} MiB filled); about ${String(fit)} fit in ${String(config.ramBudgetMib)} MiB`,
  );

  writeMetric('scale', {
    perImpRamMib: perImp,
    fitInBudget: fit,
    count: config.scaleCount,
    memoryMib: config.scaleMemoryMib,
    fillMib: config.scaleFillMib,
  });

  // the governor sleeps nothing unless the count passes the fit: raise
  // E2E_SCALE_COUNT or lower E2E_RAM_BUDGET_MIB when this fails
  expect(perImp).toBeGreaterThan(0);
  expect(config.scaleCount).toBeGreaterThan(fit);

  for (const name of names.slice(measured.length)) {
    const started = Date.now();

    await runImp(
      'new',
      name,
      '--image',
      resolveImageName('e2e-tiny'),
      '--memory',
      String(config.scaleMemoryMib),
    );

    createMs.push(Date.now() - started);

    await waitForExec(name);
    await runShellInImp(name, buildFillScript(config.scaleFillMib));
  }

  const rows = await listImps();

  const scaleImps = rows.filter((row) => row.name.startsWith(ctx.prefix));
  const sleeping = scaleImps.filter((row) => row.state === 'sleeping');
  const running = scaleImps.filter((row) => row.state === 'running');

  // the budget filled: the peak came within one imp of it
  const peak = Math.max(...monitor.samples.map((sample) => sample.ramUsedMib));

  console.log(
    `    ${String(scaleImps.length)} exist: ${String(running.length)} running, ${String(sleeping.length)} sleeping`,
  );

  console.log(
    `    peak ramUsedMib while creating: ${String(peak)} of ${String(config.ramBudgetMib)}`,
  );

  expect(findBudgetViolations(monitor.samples, monitor.sleeps, limits, 'running')).toStrictEqual(
    [],
  );

  expect(scaleImps).toHaveLength(config.scaleCount);
  expect(sleeping).not.toBeEmpty();
  expect(peak).toBeGreaterThan(config.ramBudgetMib - perImp);

  // LRU: every sleeping imp was last active no later than every running one
  const lastSlept = Math.max(...sleeping.map((row) => Date.parse(row.lastActiveAt)));
  const firstAwake = Math.min(...running.map((row) => Date.parse(row.lastActiveAt)));

  expect(lastSlept).toBeLessThanOrEqual(firstAwake);

  // exec wakes the least recently active imp the governor slept, memory and
  // all: its tmpfs fill is still there, and RAM stays in budget
  const [lru] = sleeping.toSorted(
    (a, b) => Date.parse(a.lastActiveAt) - Date.parse(b.lastActiveAt),
  );

  invariant(lru);

  const fillMib = await runShellInImp(lru.name, 'du -m /run/fill/blob | cut -f1');

  // a breach the wake starts shows once an enforce sleep was due
  await waitForSampleAfter(monitor, Date.now(), limits.maxStartMs);

  expect(Number(fillMib)).toBe(config.scaleFillMib);

  expect(findBudgetViolations(monitor.samples, monitor.sleeps, limits, 'running')).toStrictEqual(
    [],
  );

  // each request to a sleeping imp must wake it within the budget
  const requests: { state: string; ms: number; body: string }[] = [];

  for (const name of names) {
    const state = await readState(name);

    const started = Date.now();

    const body = await getThroughProxy(name);

    requests.push({ state, ms: Date.now() - started, body });
  }

  const wakeMs = requests
    .filter((request) => request.state === 'sleeping')
    .map((request) => request.ms);

  console.log(`    woke ${String(wakeMs.length)} sleeping imps by HTTP`);

  expect(requests.map((request) => request.body)).toStrictEqual(names.map(() => 'e2e-tiny-ok'));
  expect(wakeMs).not.toBeEmpty();

  // an imp that cannot fit even after sleeping everything else
  const huge = `${ctx.prefix}huge`;

  const rejected = await tryImp([
    'new',
    huge,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    String(config.ramBudgetMib + 1024),
  ]);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, huge));

  const leftBehind = await findImp(huge);

  expect(rejected).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('RAM_BUDGET_EXCEEDED'),
  });

  expect(leftBehind).toBeUndefined();

  // An imp that fits the budget but not its boot reserve (a share of its
  // memory, held until the RAM shows up) is refused while every awake imp is
  // held, so the governor has nothing to sleep.
  const awakeRows = await listImps();

  const held = awakeRows
    .filter((row) => row.name.startsWith(ctx.prefix) && row.state === 'running')
    .map((row) => row.name);

  // each hold's release deferred as soon as it is taken, so a later hold that
  // fails still lets the earlier ones go
  for (const name of held) {
    await runImp('hold', name, '10m');

    ctx.stack.defer(async () => {
      await tryImp(['hold', name, '0']);
    });
  }

  const info = await readInfo();

  const inUse = info.ramUsedMib + info.ramReservedMib;

  // the boot reserve is half the memory by default: twice the room, plus margin
  const tightMemory = (config.ramBudgetMib - inUse) * 2 + 512;
  const tight = `${ctx.prefix}tight`;

  const tightRejected = await tryImp([
    'new',
    tight,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    String(tightMemory),
  ]);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, tight));

  for (const name of held) {
    await runImp('hold', name, '0');
  }

  console.log(`    a ${String(tightMemory)} MiB imp with ${String(inUse)} MiB in use: refused`);

  expect(tightMemory).toBeLessThanOrEqual(config.ramBudgetMib);

  expect(tightRejected).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toInclude('RAM_BUDGET_EXCEEDED'),
  });

  // a breach the released holds start shows once an enforce sleep was due;
  // then sample until no overshoot is open, so the final check judges a
  // closed one
  await waitForSampleAfter(monitor, Date.now(), limits.maxStartMs);
  await waitForUnderBudget(monitor, limits);

  await monitor.stop();

  const maxUsed = Math.max(...monitor.samples.map((sample) => sample.ramUsedMib));
  const maxPss = Math.max(...monitor.samples.map((sample) => sample.firecrackerPssMib));
  const maxOwned = Math.max(...monitor.samples.map((sample) => sample.firecrackerOwnedMib));

  const maxFileMib = Math.max(
    ...monitor.samples.map((sample) => sample.firecrackerPssMib - sample.firecrackerOwnedMib),
  );

  const maxAwake = Math.max(...monitor.samples.map((sample) => sample.awake));

  const overshoots = findOvershoots(
    monitor.samples.map((sample) => ({ at: sample.at, usedMib: sample.ramUsedMib })),
    config.ramBudgetMib,
  );

  const pssOver = monitor.samples.filter(
    (sample) => sample.firecrackerPssMib > config.ramBudgetMib,
  ).length;

  console.log(
    `    budget held over ${String(monitor.samples.length)} samples: max ramUsedMib ${String(maxUsed)}, ` +
      `max Firecracker owned ${String(maxOwned)}, max Firecracker PSS ${String(maxPss)} ` +
      `(up to ${String(maxFileMib)} MiB of clean file pages, over the budget in ` +
      `${String(pssOver)}), max awake ${String(maxAwake)}`,
  );

  // each run of ramUsedMib over the budget, which a governor sleep ended
  for (const overshoot of overshoots) {
    console.log(
      `    ramUsedMib ${String(overshoot.maxOverMib)} MiB over the budget in ` +
        `${String(overshoot.samples.length)} samples, over ${String(readOvershootMs(overshoot))} ms`,
    );
  }

  writeMetric('scaleBudget', {
    maxRamUsedMib: maxUsed,
    maxFirecrackerOwnedMib: maxOwned,
    maxFirecrackerPssMib: maxPss,
    maxFirecrackerFileMib: maxFileMib,
    pssOverBudgetSamples: pssOver,
    overshoots: overshoots.length,
    maxOvershootMs: Math.max(0, ...overshoots.map((overshoot) => readOvershootMs(overshoot))),
    maxAwake,
    samples: monitor.samples.length,
    sleepingAfterCreate: sleeping.length,
  });

  writeMetric('createMs', buildStats(createMs));
  writeMetric('wakeMs', buildStats(wakeMs));

  expect(findBudgetViolations(monitor.samples, monitor.sleeps, limits, 'final')).toStrictEqual([]);
});
