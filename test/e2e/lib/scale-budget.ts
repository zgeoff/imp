import { findBudgetBreaches, readMaxOpenMs } from './budget-overshoot';
import type { BudgetCheck, Overshoot, OvershootLimits, SleepSpan } from './budget-overshoot';
import {
  FIRECRACKER_MEMORY_SCRIPT,
  parseFirecrackerMemory,
  readSmallestOwnedMib,
} from './firecracker-memory';
import { readInfo, requireImp } from './imp-cli';
import { runInContainer } from './instance';
import { startSleepWatch } from './sleep-events';
import { waitFor } from './wait-for';

// The sampler's rate: how often the monitor reads impd's RAM figure and
// Firecracker's memory, which sets how finely an overshoot is timed.
const BUDGET_SAMPLE_MS = 500;

export interface BudgetSample {
  // ms since the epoch, taken before the reads, so an overshoot never looks
  // shorter than it was
  readonly at: number;
  readonly ramUsedMib: number;
  readonly awake: number;
  readonly firecrackerPssMib: number;
  readonly firecrackerOwnedMib: number;
}

export interface BudgetMonitor {
  readonly samples: readonly BudgetSample[];

  // every imp's sleep, from the event stream
  readonly sleeps: readonly SleepSpan[];

  // stops the sampler and the event stream; safe to call again
  readonly stop: () => Promise<void>;
}

export interface OvershootLimitsInput {
  readonly budgetMib: number;

  // each scale imp's --memory
  readonly memoryMib: number;

  // impd's IMP_BOOT_RESERVE_PERCENT
  readonly reservePercent: number;

  // the governor's enforce period
  readonly enforceIntervalMs: number;
}

// The script that fills a scale imp: a tmpfs a little larger than the fill,
// and that many MiB of random data in it, which no page sharing can fold.
export function buildFillScript(fillMib: number): string {
  return (
    `mkdir -p /run/fill && mount -t tmpfs -o size=${String(fillMib + 16)}m tmpfs /run/fill && ` +
    `dd if=/dev/urandom of=/run/fill/blob bs=1M count=${String(fillMib)} 2>/dev/null`
  );
}

// A guest grows past its boot reserve after admission, so use may pass the
// budget by the memory its reserve leaves out, until an enforce sleep due
// within one period and one sample ends it (findBudgetBreaches)
export function buildOvershootLimits(input: Readonly<OvershootLimitsInput>): OvershootLimits {
  return {
    budgetMib: input.budgetMib,
    maxStartMs: input.enforceIntervalMs + BUDGET_SAMPLE_MS,
    maxOverMib: Math.ceil((input.memoryMib * (100 - input.reservePercent)) / 100),
  };
}

// Breaches in impd's figure and in what the VMs own per smaps, so a wrong
// figure cannot hide one; full PSS adds clean file pages the governor leaves
// out, so it is only reported (docs/guides/development.md).
export function findBudgetViolations(
  samples: readonly BudgetSample[],
  sleeps: readonly SleepSpan[],
  limits: OvershootLimits,
  check: BudgetCheck,
): readonly string[] {
  const series = [
    ['ramUsedMib', samples.map((sample) => ({ at: sample.at, usedMib: sample.ramUsedMib }))],
    [
      'Firecracker owned',
      samples.map((sample) => ({ at: sample.at, usedMib: sample.firecrackerOwnedMib })),
    ],
  ] as const;

  return series.flatMap(([name, usage]) =>
    findBudgetBreaches(usage, sleeps, limits, check).map(
      (breach) => `${name} ${String(breach.maxOverMib)} MiB over the budget: ${breach.why}`,
    ),
  );
}

// from the first sample over the budget to the last
export function readOvershootMs(overshoot: Overshoot): number {
  const [first] = overshoot.samples;
  const last = overshoot.samples.at(-1);

  return first === undefined || last === undefined ? 0 : last.at - first.at;
}

// null for a sample lost to a busy impd, which is no budget violation; a bad
// smaps read throws
async function readBudgetSample(): Promise<BudgetSample | null> {
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

// Samples the budget every BUDGET_SAMPLE_MS and follows the sleeps that end
// an overshoot. A failed read stops the sampler, and stop() rethrows it.
export async function startBudgetMonitor(): Promise<BudgetMonitor> {
  const watch = await startSleepWatch();

  const samples: BudgetSample[] = [];
  const state = { isRunning: true, stopped: null as Promise<void> | null };

  const loop = (async () => {
    while (state.isRunning) {
      const sample = await readBudgetSample();

      if (sample !== null) {
        samples.push(sample);
      }

      await Bun.sleep(BUDGET_SAMPLE_MS);
    }
  })();

  const stop = async () => {
    state.isRunning = false;

    await loop;

    await watch.stop();
  };

  return {
    samples,
    sleeps: watch.sleeps,
    stop: () => {
      state.stopped ??= stop();

      return state.stopped;
    },
  };
}

// waits until the monitor holds a sample taken `afterMs` past `since`, so a
// breach that starts at `since` has had the time to show
export async function waitForSampleAfter(
  monitor: BudgetMonitor,
  since: number,
  afterMs: number,
): Promise<void> {
  await waitFor(`a budget sample ${String(afterMs)} ms after ${String(since)}`, () => {
    const last = monitor.samples.at(-1);

    if (last === undefined || last.at < since + afterMs) {
      throw new Error(`last sample at ${String(last?.at)}`);
    }
  });
}

// Samples on until neither figure is over the budget, for at most as long as
// an open overshoot may wait for its sleep, so the final check judges a
// closed one; a figure still over then is the final check's breach.
export async function waitForUnderBudget(
  monitor: BudgetMonitor,
  limits: OvershootLimits,
): Promise<void> {
  await waitFor(
    'both budget figures under the budget',
    () => {
      const last = monitor.samples.at(-1);

      if (
        last === undefined ||
        last.ramUsedMib > limits.budgetMib ||
        last.firecrackerOwnedMib > limits.budgetMib
      ) {
        throw new Error(`last sample ${JSON.stringify(last)}`);
      }
    },
    { timeoutMs: readMaxOpenMs(limits) },
  ).catch(() => {});
}

// The smallest RAM that the named imps' VMs own, each read after its fill: the
// first may cold-boot while its boot template builds, and the imps restored
// from it own less, so more fit.
export async function readPerImpMib(names: readonly string[]): Promise<number> {
  const rows = await Promise.all(names.map((name) => requireImp(name)));
  const smaps = await runInContainer(['sh', '-c', FIRECRACKER_MEMORY_SCRIPT]);

  return readSmallestOwnedMib(
    rows.map((row) => row.id),
    parseFirecrackerMemory(smaps.stdout),
  );
}
