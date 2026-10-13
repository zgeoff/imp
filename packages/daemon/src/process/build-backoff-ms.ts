interface BackoffSpec {
  // the wait after the first failure
  readonly baseMs: number;

  // the longest wait; Infinity for none
  readonly capMs: number;
}

// The wait before the next try after `failures` failures in a row: none
// before the first failure, then `baseMs` doubling with each failure up to
// `capMs`.
export function buildBackoffMs(failures: number, spec: Readonly<BackoffSpec>): number {
  if (failures <= 0) {
    return 0;
  }

  return Math.min(spec.capMs, spec.baseMs * 2 ** (failures - 1));
}
