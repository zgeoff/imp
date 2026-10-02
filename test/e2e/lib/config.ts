function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw === '') {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got '${raw}'`);
  }

  return value;
}

// Harness knobs. The defaults are the acceptance sizes; lower them to run the
// scale suite on a smaller machine.
export const config = {
  // impd tuning, passed through scripts/dev.sh
  ramBudgetMib: readNumber('E2E_RAM_BUDGET_MIB', 6144),
  idleTimeoutS: readNumber('E2E_IDLE_TIMEOUT_S', 10),

  // scale suite
  scaleCount: readNumber('E2E_SCALE_COUNT', 30),
  scaleMemoryMib: readNumber('E2E_SCALE_MEMORY_MIB', 512),
  scaleFillMib: readNumber('E2E_SCALE_FILL_MIB', 256),

  // chaos suite: rounds of random faults, and the seed that replays them
  chaosRounds: readNumber('E2E_CHAOS_ROUNDS', 8),
  chaosSeed: readNumber('E2E_CHAOS_SEED', Date.now() % 1_000_000_007),

  // limits
  maxNewMs: readNumber('E2E_MAX_NEW_MS', 3000),
  maxCheckpointMs: readNumber('E2E_MAX_CHECKPOINT_MS', 500),

  keep: process.env['E2E_KEEP'] === '1',

  // the suites in this run, so scale can leave its imps for restart
  runSuites: (process.env['E2E_SUITES'] ?? '').split(',').filter((suite) => suite !== ''),

  // the full definition of done: tailscale fails instead of skipping
  acceptance: process.env['E2E_ACCEPTANCE'] === '1',

  // where suites append metrics; the runner merges them into results.json
  metricsFile: process.env['E2E_METRICS_FILE'] ?? null,
} as const;
