// How many refused requests of each imp the broker audits in one second.
// A refusal costs the guest almost nothing, so without a budget a guest could
// keep impd writing audit rows as fast as it can open connections.
export interface RefusalBudget {
  // true while the imp has room left in this second, and counts the entry
  readonly tryClaim: (impId: string) => boolean;
}

export interface RefusalBudgetOptions {
  readonly perSecond: number;
  readonly now: () => number;
}

export function createRefusalBudget(options: Readonly<RefusalBudgetOptions>): RefusalBudget {
  // the counts of the current second only: a new second starts them anew
  const state = { second: Number.NaN, counts: new Map<string, number>() };

  return {
    tryClaim: (impId) => {
      const second = Math.floor(options.now() / 1000);

      if (second !== state.second) {
        state.second = second;

        state.counts.clear();
      }

      const count = state.counts.get(impId) ?? 0;

      if (count >= options.perSecond) {
        return false;
      }

      state.counts.set(impId, count + 1);

      return true;
    },
  };
}
