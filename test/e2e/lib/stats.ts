export interface Stats {
  readonly n: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
}

// nearest rank, not interpolated: every value it returns was measured
export function buildPercentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) {
    return null;
  }

  const sorted = samples.toSorted((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p * sorted.length) / 100));

  return sorted[rank - 1] ?? null;
}

// the shape results.json records a series of timings in
export function buildStats(samples: readonly number[]): Stats {
  return {
    n: samples.length,
    p50: buildPercentile(samples, 50),
    p95: buildPercentile(samples, 95),
    max: buildPercentile(samples, 100),
  };
}
