export interface AsleepLine {
  readonly ms: number;

  // what stayed plugged through the sleep; null for an imp without elastic memory
  readonly pluggedMib: number | null;
}

// The newest `impd: <name>: asleep in` line in an impd log (imp-vm-ops.ts
// logs one per sleep), or null when the log holds none for that imp.
export function findAsleepLine(log: string, name: string): AsleepLine | null {
  const line = log
    .split('\n')
    .findLast((candidate) => candidate.includes(`impd: ${name}: asleep in `));

  if (line === undefined) {
    return null;
  }

  const ms = /: asleep in (?<ms>\d+)ms /v.exec(line)?.groups?.['ms'];
  const plugged = /, (?<plugged>\d+) MiB plugged,/v.exec(line)?.groups?.['plugged'];

  if (ms === undefined) {
    throw new Error(`no duration in ${JSON.stringify(line)}`);
  }

  return { ms: Number(ms), pluggedMib: plugged === undefined ? null : Number(plugged) };
}
