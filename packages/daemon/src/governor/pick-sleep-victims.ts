export interface VictimCandidate {
  readonly id: string;
  readonly ramMib: number;
  readonly lastActiveAt: number;

  // a hold, or a lifecycle operation in progress: never a victim
  readonly held: boolean;
  readonly busy: boolean;
}

export interface SleepVictims<Candidate extends VictimCandidate> {
  // oldest first
  readonly victims: Candidate[];

  // false when every eligible imp together frees less than asked: `victims`
  // then lists all of them
  readonly enough: boolean;
}

// The least recently active imps whose RAM together frees `needMib`.
export function pickSleepVictims<Candidate extends VictimCandidate>(
  candidates: readonly Candidate[],
  needMib: number,
): SleepVictims<Candidate> {
  if (needMib <= 0) {
    return { victims: [], enough: true };
  }

  const eligible = candidates
    .filter((candidate) => !candidate.held && !candidate.busy)
    .toSorted((a, b) => a.lastActiveAt - b.lastActiveAt);

  const victims: Candidate[] = [];
  let freed = 0;

  for (const candidate of eligible) {
    victims.push(candidate);

    freed += candidate.ramMib;

    if (freed >= needMib) {
      return { victims, enough: true };
    }
  }

  return { victims, enough: false };
}
