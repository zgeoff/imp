export interface UsageSample {
  // ms since the epoch
  readonly at: number;
  readonly usedMib: number;
}

// an imp's sleep, from its `ImpChanged slept` event: `at` less `durationMs`
export interface SleepSpan {
  readonly startAt: number;
  readonly endAt: number;
}

export interface OvershootLimits {
  readonly budgetMib: number;

  // how soon after the first sample over the budget a sleep must start: one
  // enforce period plus one sample
  readonly maxStartMs: number;

  // how far one overshoot may go: one imp's boot reserve
  readonly maxOverMib: number;
}

export interface Overshoot {
  // the samples over the budget, in a row
  readonly samples: readonly UsageSample[];
  readonly maxOverMib: number;
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
      overshoots.push(buildOvershoot(run, budgetMib));

      run = [];
    }
  }

  if (run.length > 0) {
    overshoots.push(buildOvershoot(run, budgetMib));
  }

  return overshoots;
}

function buildOvershoot(run: readonly UsageSample[], budgetMib: number): Overshoot {
  return {
    samples: run,
    maxOverMib: Math.max(...run.map((sample) => sample.usedMib - budgetMib)),
  };
}

// A breach: over by more than one boot reserve, no sleep started within
// `maxStartMs` while use stays over, or use still over after that sleep ended.
// The sleep's own length does not count: the sleep is what frees the RAM.
export function findBudgetBreaches(
  samples: readonly UsageSample[],
  sleeps: readonly SleepSpan[],
  limits: OvershootLimits,
): readonly BudgetBreach[] {
  return findOvershoots(samples, limits.budgetMib).flatMap((overshoot) => {
    const why = checkOvershoot(overshoot, sleeps, limits);
    const [first] = overshoot.samples;

    return why === null || first === undefined
      ? []
      : [{ startAt: first.at, maxOverMib: overshoot.maxOverMib, why }];
  });
}

function checkOvershoot(
  overshoot: Overshoot,
  sleeps: readonly SleepSpan[],
  limits: OvershootLimits,
): string | null {
  if (overshoot.maxOverMib > limits.maxOverMib) {
    return `over by more than one boot reserve (${String(limits.maxOverMib)} MiB)`;
  }

  const [first] = overshoot.samples;

  if (first === undefined) {
    return null;
  }

  const deadline = first.at + limits.maxStartMs;

  // the sleep that ends it: one under way or started by the deadline
  const sleep = sleeps
    .filter((span) => span.endAt >= first.at && span.startAt <= deadline)
    .toSorted((a, b) => a.endAt - b.endAt)
    .at(0);

  if (sleep === undefined) {
    const late = overshoot.samples.some((sample) => sample.at > deadline);

    return late ? `no sleep started within ${String(limits.maxStartMs)} ms` : null;
  }

  if (overshoot.samples.some((sample) => sample.at >= sleep.endAt)) {
    return `still over after the sleep that ended ${String(sleep.endAt - first.at)} ms in`;
  }

  return null;
}
