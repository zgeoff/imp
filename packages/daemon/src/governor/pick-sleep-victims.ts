export interface VictimCandidate {
  readonly id: string;
  readonly ramMib: number;
  readonly lastActiveAt: number;

  // a hold, or a lifecycle operation in progress: never a victim
  readonly held: boolean;
  readonly busy: boolean;
}

// The least recently active imps whose RAM together frees `needMib`, oldest
// first; null when every eligible imp together is not enough.
export function pickSleepVictims(
  candidates: readonly VictimCandidate[],
  needMib: number,
): string[] | null {
  if (needMib <= 0) {
    return [];
  }

  const eligible = candidates
    .filter((candidate) => !candidate.held && !candidate.busy)
    .toSorted((a, b) => a.lastActiveAt - b.lastActiveAt);

  const victims: string[] = [];
  let freed = 0;

  for (const candidate of eligible) {
    victims.push(candidate.id);

    freed += candidate.ramMib;

    if (freed >= needMib) {
      return victims;
    }
  }

  return null;
}
