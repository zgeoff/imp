// The distance between two u32 values, around the wrap: how far apart two
// guests' TCP ISN secrets lie.
export function findU32Span(a: number, b: number): number {
  const span = Math.abs(a - b);

  return Math.min(span, 2 ** 32 - span);
}

// The `step=12ms` pairs of the last impd log line that names the imp and
// `what`, with `total` from a `created in 40ms`; empty when no line matches.
export function parseLoggedSteps(
  log: string,
  name: string,
  what: string,
): Readonly<Record<string, number>> {
  const line = log.split('\n').findLast((candidate) => candidate.includes(`${name}: ${what}`));

  if (line === undefined) {
    return {};
  }

  const steps = Object.fromEntries(
    Array.from(line.matchAll(/(?<step>\w+)=(?<ms>\d+)ms/gv), (match) => [
      match.groups?.['step'] ?? '',
      Number(match.groups?.['ms']),
    ]),
  );

  const total = /created in (?<ms>\d+)ms/v.exec(line)?.groups?.['ms'];

  return total === undefined ? steps : { ...steps, total: Number(total) };
}

// the nearest-rank percentile, 0 for no values
export function pickPercentile(values: readonly number[], fraction: number): number {
  const sorted = values.toSorted((a, b) => a - b);

  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}
