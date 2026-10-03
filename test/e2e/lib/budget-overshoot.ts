export interface UsageSample {
  // ms since the epoch
  readonly at: number;
  readonly usedMib: number;
}

export interface OvershootLimits {
  readonly budgetMib: number;

  // how long use may stay over: one enforce period plus one sample
  readonly maxMs: number;

  // how far one overshoot may go: one imp's boot reserve
  readonly maxOverMib: number;
}

export interface Overshoot {
  readonly startAt: number;

  // from the first sample over the budget to the last one
  readonly ms: number;
  readonly maxOverMib: number;
}

// Runs of consecutive samples over the budget. A booting guest grows past its
// boot reserve, so a run is expected; the governor's enforce pass ends it.
export function findOvershoots(
  samples: readonly UsageSample[],
  budgetMib: number,
): readonly Overshoot[] {
  const overshoots: Overshoot[] = [];
  let run: UsageSample[] = [];

  const collectRun = () => {
    const [first] = run;
    const last = run.at(-1);

    if (first !== undefined && last !== undefined) {
      overshoots.push({
        startAt: first.at,
        ms: last.at - first.at,
        maxOverMib: Math.max(...run.map((sample) => sample.usedMib - budgetMib)),
      });
    }

    run = [];
  };

  for (const sample of samples) {
    if (sample.usedMib > budgetMib) {
      run.push(sample);
    } else {
      collectRun();
    }
  }

  collectRun();

  return overshoots;
}

// the overshoots that lasted or went further than the governor allows
export function findBudgetBreaches(
  samples: readonly UsageSample[],
  limits: OvershootLimits,
): readonly Overshoot[] {
  return findOvershoots(samples, limits.budgetMib).filter(
    (overshoot) => overshoot.ms > limits.maxMs || overshoot.maxOverMib > limits.maxOverMib,
  );
}
