export interface UsageSample {
  // ms since the epoch, taken before the reads
  readonly at: number;
  readonly usedMib: number;
}

// an imp's sleep, from its `ImpChanged slept` event
export interface SleepSpan {
  readonly startAt: number;
  readonly endAt: number;

  // slept by the governor's enforce pass, not to make room for an admission
  readonly isEnforce: boolean;
}

export interface OvershootLimits {
  readonly budgetMib: number;

  // how soon after the first sample over the budget an enforce sleep must
  // start while use stays over: one enforce period plus one sample
  readonly maxStartMs: number;

  // how far one overshoot may go: the most a guest grows past its reserve
  readonly maxOverMib: number;
}

// a sleep longer than this has hung
const MAX_SLEEP_MS = 30_000;

// `running`: an overshoot still open may wait on a sleep under way. `final`:
// the run has ended, so one still open is a breach.
export type BudgetCheck = 'running' | 'final';

// how long an open overshoot may wait for its sleep: sample until none is
// open, for at most this, before the final check
export function readMaxOpenMs(limits: OvershootLimits): number {
  return limits.maxStartMs + MAX_SLEEP_MS;
}

export interface Overshoot {
  // the samples over the budget, in a row
  readonly samples: readonly UsageSample[];
  readonly maxOverMib: number;

  // still over at the last sample
  readonly isOpen: boolean;
}

export interface BudgetBreach {
  readonly startAt: number;
  readonly maxOverMib: number;
  readonly why: string;
}

// Runs of consecutive samples over the budget. A booting guest grows past its
// boot reserve, so a run is expected; a governor sleep ends it.
export function findOvershoots(
  samples: readonly UsageSample[],
  budgetMib: number,
): readonly Overshoot[] {
  const overshoots: Overshoot[] = [];
  let run: UsageSample[] = [];

  for (const sample of samples) {
    if (sample.usedMib > budgetMib) {
      run.push(sample);
    } else if (run.length > 0) {
      overshoots.push(buildOvershoot(run, budgetMib, false));

      run = [];
    }
  }

  if (run.length > 0) {
    overshoots.push(buildOvershoot(run, budgetMib, true));
  }

  return overshoots;
}

function buildOvershoot(
  run: readonly UsageSample[],
  budgetMib: number,
  isOpen: boolean,
): Overshoot {
  return {
    samples: run,
    maxOverMib: Math.max(...run.map((sample) => sample.usedMib - budgetMib)),
    isOpen,
  };
}

export function findBudgetBreaches(
  samples: readonly UsageSample[],
  sleeps: readonly SleepSpan[],
  limits: OvershootLimits,
  check: BudgetCheck = 'running',
): readonly BudgetBreach[] {
  return findOvershoots(samples, limits.budgetMib).flatMap((overshoot) => {
    const why =
      check === 'final' && overshoot.isOpen
        ? 'still over the budget when the run ended'
        : checkOvershoot(overshoot, sleeps, limits);

    const [first] = overshoot.samples;

    return why === null || first === undefined
      ? []
      : [{ startAt: first.at, maxOverMib: overshoot.maxOverMib, why }];
  });
}

// Use may fall under the budget for any reason. Still over past `maxStartMs`,
// an enforce sleep must have started by then, ended within MAX_SLEEP_MS, and
// left use under the budget; a sleep's own length does not count against it.
function checkOvershoot(
  overshoot: Overshoot,
  sleeps: readonly SleepSpan[],
  limits: OvershootLimits,
): string | null {
  if (overshoot.maxOverMib > limits.maxOverMib) {
    return `over by more than a guest grows past its reserve (${String(limits.maxOverMib)} MiB)`;
  }

  const [first] = overshoot.samples;
  const last = overshoot.samples.at(-1);

  if (first === undefined || last === undefined) {
    return null;
  }

  const deadline = first.at + limits.maxStartMs;

  if (last.at <= deadline) {
    return null;
  }

  const sleep = sleeps
    .filter((span) => span.isEnforce && span.endAt >= first.at && span.startAt <= deadline)
    .toSorted((a, b) => a.endAt - b.endAt)
    .at(0);

  if (sleep === undefined) {
    // a sleep under way has no event yet; past the longest a sleep may take
    // it has hung or never started
    const pending = overshoot.isOpen && last.at <= deadline + MAX_SLEEP_MS;

    return pending ? null : `no enforce sleep started within ${String(limits.maxStartMs)} ms`;
  }

  if (sleep.endAt - sleep.startAt > MAX_SLEEP_MS) {
    return `the enforce sleep took ${String(sleep.endAt - sleep.startAt)} ms`;
  }

  if (overshoot.samples.some((sample) => sample.at >= sleep.endAt)) {
    return `still over after the enforce sleep that ended ${String(sleep.endAt - first.at)} ms in`;
  }

  return null;
}
