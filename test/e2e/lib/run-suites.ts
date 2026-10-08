export interface RunSuitesDeps {
  // the run's suites, in run order
  readonly names: readonly string[];
  readonly prefixOf: (name: string) => string;

  // --keep: what each suite made stays
  readonly keep: boolean;

  // runs one suite to its exit and returns its exit code; the caller forgets
  // the suite's process group once this settles, before any reset
  readonly runSuite: (name: string) => Promise<number>;

  // what else decides the verdict, such as the boot-fallback scan
  readonly checkSuite: (name: string) => Promise<boolean>;
  readonly reset: (prefixes: readonly string[]) => Promise<void>;

  // the instance back on the run's settings, after a suite that failed
  readonly reboot: () => Promise<void>;

  // a fresh instance with the run's settings, when a reset cannot restore
  // the baseline
  readonly recreate: () => Promise<void>;
  readonly isInterrupted: () => boolean;
  readonly now: () => number;
  readonly onSuiteStart: (name: string) => void;
  readonly onSuiteEnd: (result: Readonly<SuiteResult>) => void;
  readonly log: (line: string) => void;
}

interface SuiteResult {
  readonly name: string;
  readonly passed: boolean;
  readonly ms: number;
}

export interface RunSuitesResult {
  readonly results: readonly SuiteResult[];

  // why the run stopped before its last suite, or null
  readonly stoppedBecause: string | null;
}

function readReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Runs the suites in turn and resets after each, rebooting first after a
// failure; an unrestorable baseline means a fresh instance, and a failed one
// stops the run. scale's imps wait for restart's reset.
export async function runSuites(deps: Readonly<RunSuitesDeps>): Promise<RunSuitesResult> {
  const results: SuiteResult[] = [];
  let carried: readonly string[] = [];

  for (const name of deps.names) {
    if (deps.isInterrupted()) {
      return { results, stoppedBecause: 'interrupted' };
    }

    deps.onSuiteStart(name);

    const started = deps.now();

    const verdict = await runChecked(deps, name);

    const prefix = deps.prefixOf(name);
    const isKeptForRestart = name === 'scale' && deps.names.includes('restart');
    const prefixes = [prefix, ...carried];

    // a suite kept for restart is never reset here, so a fresh instance
    // never has a carry to drop
    carried = isKeptForRestart ? [prefix] : [];

    let isRestored = true;
    let stoppedBecause: string | null = null;

    if (!deps.keep && !isKeptForRestart) {
      try {
        if (!verdict.isPassed && !deps.isInterrupted()) {
          await deps.reboot();
        }

        await deps.reset(prefixes);
      } catch (error) {
        isRestored = false;

        deps.log(`    the ${name} suite left the baseline dirty: ${readReason(error)}`);
      }
    }

    if (!isRestored && !deps.isInterrupted()) {
      try {
        await deps.recreate();
      } catch (error) {
        stoppedBecause = `the instance could not be made anew after ${name}: ${readReason(error)}`;
      }
    }

    const result = {
      name,
      passed: verdict.isPassed && verdict.isClean && isRestored,
      ms: deps.now() - started,
    };

    results.push(result);
    deps.onSuiteEnd(result);

    if (stoppedBecause !== null) {
      return { results, stoppedBecause };
    }
  }

  return { results, stoppedBecause: deps.isInterrupted() ? 'interrupted' : null };
}

interface SuiteVerdict {
  readonly isPassed: boolean;
  readonly isClean: boolean;
}

// A suite that throws, or whose checks throw, fails like one that exits
// non-zero, and the run goes on.
async function runChecked(deps: Readonly<RunSuitesDeps>, name: string): Promise<SuiteVerdict> {
  let isPassed = false;

  try {
    const exitCode = await deps.runSuite(name);

    isPassed = exitCode === 0;
  } catch (error) {
    deps.log(`    the ${name} suite could not run: ${readReason(error)}`);
  }

  try {
    const isClean = await deps.checkSuite(name);

    return { isPassed, isClean };
  } catch (error) {
    deps.log(`    the ${name} suite's checks failed: ${readReason(error)}`);

    return { isPassed, isClean: false };
  }
}

export interface RunVerdictInput {
  // each section's verdict, setup included
  readonly passed: readonly boolean[];
  readonly stoppedBecause: string | null;
  readonly interrupted: boolean;
}

// A run passes only when every section passed, nothing stopped it, and no
// signal came, even one after the last suite ended.
export function checkRunPassed(input: Readonly<RunVerdictInput>): boolean {
  return input.passed.every(Boolean) && input.stoppedBecause === null && !input.interrupted;
}
