import { beforeAll, expect, test } from 'bun:test';
import { loadConfig } from '../../../packages/daemon/src/config';
import { ENFORCE_INTERVAL_MS } from '../../../packages/daemon/src/governor/ram-governor';
import { findBudgetBreaches, findOvershoots, readMaxOpenMs } from '../lib/budget-overshoot';
import type { BudgetCheck, Overshoot, OvershootLimits, SleepSpan } from '../lib/budget-overshoot';
import { config } from '../lib/config';
import {
  FIRECRACKER_MEMORY_SCRIPT,
  parseFirecrackerMemory,
  readSmallestOwnedMib,
} from '../lib/firecracker-memory';
import { resolveImageName } from '../lib/fixtures';
import { getThroughProxy } from '../lib/http';
import {
  findImp,
  listImps,
  readInfo,
  readState,
  requireImp,
  runImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { registerImp, removeImps, waitForExec } from '../lib/imps';
import { runDevScript, runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { startSleepWatch } from '../lib/sleep-events';
import { buildStats } from '../lib/stats';
import { writeMetric } from '../lib/write-metric';

const prefix = setupSuite('scale');
const TINY = resolveImageName('e2e-tiny');

// restart re-adopts a full house when it runs after this suite
const leaveForRestart = config.runSuites.includes('restart');

// long enough that only the governor sleeps imps during the suite
const SCALE_IDLE_TIMEOUT_S = 600;
const BUDGET_SAMPLE_MS = 500;

// The governor, not the idle timeout, must pick who sleeps, or the budget
// never fills. The instance keeps this timeout for the suites after scale.
beforeAll(async () => {
  process.env['IMP_IDLE_TIMEOUT_S'] = String(SCALE_IDLE_TIMEOUT_S);

  await runDevScript('reboot');
}, 600_000);

const FILL_SCRIPT =
  `mkdir -p /run/fill && mount -t tmpfs -o size=${String(config.scaleFillMib + 16)}m tmpfs /run/fill && ` +
  `dd if=/dev/urandom of=/run/fill/blob bs=1M count=${String(config.scaleFillMib)} 2>/dev/null`;

interface BudgetSample {
  // ms since the epoch
  readonly at: number;
  readonly ramUsedMib: number;
  readonly awake: number;
  readonly firecrackerPssMib: number;
  readonly firecrackerOwnedMib: number;
}

interface BudgetMonitor {
  readonly samples: readonly BudgetSample[];

  // every imp's sleep, from the event stream
  readonly sleeps: readonly SleepSpan[];
  readonly stop: () => Promise<void>;
}

// null for a sample lost to a busy impd, which is not a budget violation; a
// bad smaps read throws, and stop() rethrows it
async function readBudgetSample(): Promise<BudgetSample | null> {
  // before the reads, so an overshoot never looks shorter than it was
  const at = Date.now();

  const info = await readInfo().catch(() => null);

  if (info === null) {
    return null;
  }

  const smaps = await runInContainer(['sh', '-c', FIRECRACKER_MEMORY_SCRIPT]);

  const memory = parseFirecrackerMemory(smaps.stdout);

  return {
    at,
    ramUsedMib: info.ramUsedMib,
    awake: info.awakeCount,
    firecrackerPssMib: memory.pssMib,
    firecrackerOwnedMib: memory.ownedMib,
  };
}

// samples impd's RAM figure and Firecracker's memory about every 0.5 s, and
// follows the sleeps that end an overshoot
async function startBudgetMonitor(): Promise<BudgetMonitor> {
  const watch = await startSleepWatch();

  const samples: BudgetSample[] = [];
  const state = { running: true };

  const loop = (async () => {
    while (state.running) {
      const sample = await readBudgetSample();

      if (sample !== null) {
        samples.push(sample);
      }

      await Bun.sleep(BUDGET_SAMPLE_MS);
    }
  })();

  return {
    samples,
    sleeps: watch.sleeps,
    stop: async () => {
      state.running = false;

      await loop;

      await watch.stop();
    },
  };
}

// A guest grows past its boot reserve after admission, so use may pass the
// budget until a governor sleep ends (findBudgetBreaches has the rules). Read
// at run time: the ksm suite changes IMP_BOOT_RESERVE_PERCENT.
function readOvershootLimits(): OvershootLimits {
  const reservePercent = loadConfig({
    IMP_BOOT_RESERVE_PERCENT: process.env['IMP_BOOT_RESERVE_PERCENT'],
  }).bootReservePercent;

  return {
    budgetMib: config.ramBudgetMib,
    maxStartMs: ENFORCE_INTERVAL_MS + BUDGET_SAMPLE_MS,
    maxOverMib: Math.ceil((config.scaleMemoryMib * (100 - reservePercent)) / 100),
  };
}

// impd's figure, and what the VMs own read from smaps here so a wrong figure
// from impd cannot hide a breach; full PSS adds clean file pages the governor
// leaves out, so it is only reported (docs/guides/development.md)
const BUDGET_SERIES = [
  ['ramUsedMib', (sample: BudgetSample) => sample.ramUsedMib],
  ['Firecracker owned', (sample: BudgetSample) => sample.firecrackerOwnedMib],
] as const;

function findViolations(monitor: BudgetMonitor, check: BudgetCheck = 'running'): readonly string[] {
  return BUDGET_SERIES.flatMap(([name, read]) => {
    const usage = monitor.samples.map((sample) => ({ at: sample.at, usedMib: read(sample) }));

    return findBudgetBreaches(usage, monitor.sleeps, readOvershootLimits(), check).map(
      (breach) => `${name} ${String(breach.maxOverMib)} MiB over the budget: ${breach.why}`,
    );
  });
}

// from the first sample over the budget to the last
function readOvershootMs(overshoot: Overshoot): number {
  return (overshoot.samples.at(-1)?.at ?? 0) - (overshoot.samples[0]?.at ?? 0);
}

// Samples on until neither figure is over the budget, for at most as long as
// an open overshoot may wait for its sleep, so the final check judges a
// closed one.
async function waitForUnderBudget(monitor: BudgetMonitor): Promise<void> {
  const deadline = Date.now() + readMaxOpenMs(readOvershootLimits());

  const isOver = () => {
    const last = monitor.samples.at(-1);

    return BUDGET_SERIES.some(([, read]) => last !== undefined && read(last) > config.ramBudgetMib);
  };

  while (isOver() && Date.now() < deadline) {
    await Bun.sleep(BUDGET_SAMPLE_MS);
  }
}

function buildName(index: number): string {
  return `${prefix}${String(index).padStart(2, '0')}`;
}

// creates one scale imp and fills its tmpfs; returns the `imp new` time
async function createFilledImp(name: string): Promise<number> {
  if (!leaveForRestart) {
    registerImp(name);
  }

  const started = Date.now();

  await runImp('new', name, '--image', TINY, '--memory', String(config.scaleMemoryMib));

  const ms = Date.now() - started;

  await waitForExec(name);
  await runShellInImp(name, FILL_SCRIPT);

  return ms;
}

// The smallest RAM of the first `count` imps, each read after its fill: imp
// 1 may cold-boot while its boot template builds, and the imps restored from
// it own less, so more fit.
async function readPerImpMib(count: number): Promise<number> {
  const ids: string[] = [];

  for (let index = 1; index <= count; index++) {
    const row = await requireImp(buildName(index));

    ids.push(row.id);
  }

  const smaps = await runInContainer(['sh', '-c', FIRECRACKER_MEMORY_SCRIPT]);

  return readSmallestOwnedMib(ids, parseFirecrackerMemory(smaps.stdout));
}

// An imp that fits the budget but not its boot reserve (a share of its
// memory, held until the RAM shows up) while every awake imp is held, so the
// governor has nothing to sleep, is refused.
async function assertBootReserveRefused(): Promise<void> {
  const rows = await listImps();

  const awake = rows.filter((row) => row.name.startsWith(prefix) && row.state === 'running');

  for (const row of awake) {
    await runImp('hold', row.name, '10m');
  }

  try {
    const info = await readInfo();

    const inUse = info.ramUsedMib + info.ramReservedMib;

    // the boot reserve is half the memory by default: twice the room, plus margin
    const memory = (config.ramBudgetMib - inUse) * 2 + 512;
    const tight = `${prefix}tight`;

    expect(memory).toBeLessThanOrEqual(config.ramBudgetMib);

    registerImp(tight);

    const rejected = await tryImp(['new', tight, '--image', TINY, '--memory', String(memory)]);

    await removeImps(tight);

    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr).toContain('RAM_BUDGET_EXCEEDED');

    console.log(`    a ${String(memory)} MiB imp with ${String(inUse)} MiB in use: refused`);
  } finally {
    for (const row of awake) {
      await runImp('hold', row.name, '0');
    }
  }
}

test(`${String(config.scaleCount)} imps stay inside the RAM budget and wake on request`, async () => {
  const start = await readInfo();

  expect(start.ramBudgetMib).toBe(config.ramBudgetMib);
  expect(config.scaleMemoryMib * 2).toBeLessThanOrEqual(config.ramBudgetMib);

  const monitor = await startBudgetMonitor();

  const createMs: number[] = [];
  const wakeMs: number[] = [];
  let sleepingAfterCreate = 0;
  let perImp = 0;

  try {
    // two imps before the measure: the second restores from the boot
    // template when the first built it
    const measured = Math.min(2, config.scaleCount);

    for (let index = 1; index <= measured; index++) {
      const ms = await createFilledImp(buildName(index));

      createMs.push(ms);
    }

    perImp = await readPerImpMib(measured);

    const fit = Math.floor(config.ramBudgetMib / perImp);

    expect(perImp).toBeGreaterThan(0);

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

    // the governor sleeps nothing unless the count passes the fit
    if (config.scaleCount <= fit) {
      throw new Error(
        `E2E_SCALE_COUNT ${String(config.scaleCount)} fits in the budget at ${String(perImp)} MiB ` +
          'per imp, so the governor would sleep none: raise the count or lower E2E_RAM_BUDGET_MIB',
      );
    }

    for (let index = measured + 1; index <= config.scaleCount; index++) {
      const ms = await createFilledImp(buildName(index));

      createMs.push(ms);

      expect(findViolations(monitor)).toBeEmpty();
    }

    const rows = await listImps();

    const scaleImps = rows.filter((row) => row.name.startsWith(prefix));
    const sleeping = scaleImps.filter((row) => row.state === 'sleeping');
    const running = scaleImps.filter((row) => row.state === 'running');

    console.log(
      `    ${String(scaleImps.length)} exist: ${String(running.length)} running, ${String(sleeping.length)} sleeping`,
    );

    expect(scaleImps).toHaveLength(config.scaleCount);
    expect(sleeping).not.toBeEmpty();

    // the budget filled: the peak came within one imp of it
    const peak = Math.max(...monitor.samples.map((sample) => sample.ramUsedMib));

    console.log(
      `    peak ramUsedMib while creating: ${String(peak)} of ${String(config.ramBudgetMib)}`,
    );

    expect(peak).toBeGreaterThan(config.ramBudgetMib - perImp);

    sleepingAfterCreate = sleeping.length;

    // LRU: every sleeping imp was last active no later than every running one
    const lastSlept = Math.max(...sleeping.map((row) => Date.parse(row.lastActiveAt)));
    const firstAwake = Math.min(...running.map((row) => Date.parse(row.lastActiveAt)));

    expect(lastSlept).toBeLessThanOrEqual(firstAwake);

    // exec wakes the least recently active imp the governor slept, memory
    // and all: its tmpfs fill is still there, and RAM stays in budget
    const [lru] = sleeping.toSorted(
      (a, b) => Date.parse(a.lastActiveAt) - Date.parse(b.lastActiveAt),
    );

    const fillMib = await runShellInImp(lru?.name ?? '', 'du -m /run/fill/blob | cut -f1');

    expect(Number(fillMib)).toBe(config.scaleFillMib);

    await Bun.sleep(3000);

    expect(findViolations(monitor)).toBeEmpty();

    // each request to a sleeping imp must wake it within the budget
    for (let index = 1; index <= config.scaleCount; index++) {
      const name = buildName(index);

      const state = await readState(name);

      const started = Date.now();

      const body = await getThroughProxy(name);

      if (state === 'sleeping') {
        wakeMs.push(Date.now() - started);
      }

      expect(body).toBe('e2e-tiny-ok');
    }

    console.log(`    woke ${String(wakeMs.length)} sleeping imps by HTTP`);

    expect(wakeMs).not.toBeEmpty();

    // an imp that cannot fit even after sleeping everything else
    const huge = `${prefix}huge`;
    const memory = String(config.ramBudgetMib + 1024);

    registerImp(huge);

    const rejected = await tryImp(['new', huge, '--image', TINY, '--memory', memory]);
    const leftBehind = await findImp(huge);

    await removeImps(huge);

    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr).toContain('RAM_BUDGET_EXCEEDED');
    expect(leftBehind).toBeUndefined();

    await assertBootReserveRefused();

    await Bun.sleep(2000);

    await waitForUnderBudget(monitor);
  } finally {
    await monitor.stop();
  }

  expect(findViolations(monitor, 'final')).toBeEmpty();

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
    sleepingAfterCreate,
  });

  writeMetric('createMs', buildStats(createMs));
  writeMetric('wakeMs', buildStats(wakeMs));
});
