export interface RunSuitesDeps {
  // the run's suites, in run order
  readonly names: readonly string[];
  readonly prefixOf: (name: string) => string;

  // each suite's journey files, in run order
  readonly journeysOf: (name: string) => readonly string[];

  // --keep: what each journey left stays
  readonly keep: boolean;

  // runs one journey file to its exit and returns its exit code; the caller
  // forgets the journey's process group once this settles, before any reset
  readonly runJourney: (journey: string) => Promise<number>;

  // what else decides a journey's verdict, such as the boot-fallback scan
  readonly checkJourney: (suite: string, journey: string) => Promise<boolean>;
  readonly reset: (prefixes: readonly string[]) => Promise<void>;

  // the instance back on the run's settings, after a journey that failed
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

// Runs each suite's journeys in turn, resetting its prefix after each one
// (a reboot first after a failure); an unrestorable baseline means a fresh
// instance, and a failed one stops the run. scale's imps wait for restart.
export async function runSuites(deps: Readonly<RunSuitesDeps>): Promise<RunSuitesResult> {
  const results: SuiteResult[] = [];
  let carried: readonly string[] = [];

  for (const name of deps.names) {
    if (deps.isInterrupted()) {
      return { results, stoppedBecause: 'interrupted' };
    }

    deps.onSuiteStart(name);

    const started = deps.now();
    const prefix = deps.prefixOf(name);
    const isKeptForRestart = name === 'scale' && deps.names.includes('restart');
    const prefixes = [prefix, ...carried];

    // a suite kept for restart is never reset here, so a fresh instance
    // never has a carry to drop
    carried = isKeptForRestart ? [prefix] : [];

    let isPassed = true;
    let stoppedBecause: string | null = null;

    for (const journey of deps.journeysOf(name)) {
      // a journey that never ran fails its suite
      if (deps.isInterrupted()) {
        isPassed = false;
        break;
      }

      const verdict = await runChecked(deps, name, journey);

      const isRestored = await resetAfterJourney(deps, journey, verdict.isPassed, {
        prefixes,
        isSkipped: deps.keep || isKeptForRestart,
      });

      if (!isRestored && !deps.isInterrupted()) {
        try {
          await deps.recreate();
        } catch (error) {
          stoppedBecause = `the instance could not be made anew after ${journey}: ${readReason(error)}`;
        }
      }

      isPassed &&= verdict.isPassed && verdict.isClean && isRestored;

      if (stoppedBecause !== null) {
        break;
      }
    }

    const result = { name, passed: isPassed, ms: deps.now() - started };

    results.push(result);
    deps.onSuiteEnd(result);

    if (stoppedBecause !== null) {
      return { results, stoppedBecause };
    }
  }

  return { results, stoppedBecause: deps.isInterrupted() ? 'interrupted' : null };
}

interface RestoreOptions {
  readonly prefixes: readonly string[];

  // --keep, or scale's imps kept for restart
  readonly isSkipped: boolean;
}

// The reset after one journey file, with a reboot first when it failed and
// the run goes on; false when the baseline could not be restored.
async function resetAfterJourney(
  deps: Readonly<RunSuitesDeps>,
  journey: string,
  isPassed: boolean,
  options: Readonly<RestoreOptions>,
): Promise<boolean> {
  if (options.isSkipped) {
    return true;
  }

  try {
    if (!isPassed && !deps.isInterrupted()) {
      await deps.reboot();
    }

    await deps.reset(options.prefixes);

    return true;
  } catch (error) {
    deps.log(`    the ${journey} journey left the baseline dirty: ${readReason(error)}`);

    return false;
  }
}

interface JourneyVerdict {
  readonly isPassed: boolean;
  readonly isClean: boolean;
}

// A journey that throws, or whose checks throw, fails like one that exits
// non-zero, and the run goes on.
async function runChecked(
  deps: Readonly<RunSuitesDeps>,
  suite: string,
  journey: string,
): Promise<JourneyVerdict> {
  let isPassed = false;

  try {
    const exitCode = await deps.runJourney(journey);

    isPassed = exitCode === 0;
  } catch (error) {
    deps.log(`    the ${journey} journey could not run: ${readReason(error)}`);
  }

  try {
    const isClean = await deps.checkJourney(suite, journey);

    return { isPassed, isClean };
  } catch (error) {
    deps.log(`    the ${journey} journey's checks failed: ${readReason(error)}`);

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
