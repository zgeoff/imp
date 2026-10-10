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

  // the impd settings a suite runs on, read as it starts; null for the run's
  readonly settingsOf: (name: string) => Readonly<Record<string, string>> | null;

  // the instance on a suite's settings
  readonly rebootOnto: (settings: Readonly<Record<string, string>>) => Promise<void>;

  // the instance back on the run's settings, after a journey that failed or
  // a suite with settings of its own
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

    // A suite's own settings: every journey runs on them, rebooted onto
    // before the first and after a fresh instance, and back onto the run's
    // after the last, a failure or an interrupt.
    const settings = readSettings(deps, name);
    const ownSettings = settings ?? null;

    // whether the instance may be off the run's settings, and needs the
    // reboot back
    let isOffRunSettings = false;

    // whether it runs on the suite's settings now
    let isOnSettings = false;

    if (settings === undefined) {
      isPassed = false;
    }

    for (const journey of settings === undefined ? [] : deps.journeysOf(name)) {
      // a journey that never ran fails its suite
      if (deps.isInterrupted()) {
        isPassed = false;
        break;
      }

      if (ownSettings !== null && !isOnSettings) {
        isOffRunSettings = true;

        isOnSettings = await runRebootOnto(deps, name, ownSettings);

        // a signal during the reboot finds no journey to stop, so none starts
        if (!isOnSettings || deps.isInterrupted()) {
          isPassed = false;
          break;
        }
      }

      const verdict = await runChecked(deps, name, journey);

      const isRestored = await resetAfterJourney(deps, journey, verdict.isPassed, {
        prefixes,
        isSkipped: deps.keep || isKeptForRestart,
        reboot: ownSettings === null ? deps.reboot : () => deps.rebootOnto(ownSettings),
      });

      if (!isRestored && !deps.isInterrupted()) {
        try {
          await deps.recreate();

          // a fresh instance comes up on the run's settings
          isOnSettings = false;
          isOffRunSettings = false;
        } catch (error) {
          stoppedBecause = `the instance could not be made anew after ${journey}: ${readReason(error)}`;
        }
      }

      isPassed &&= verdict.isPassed && verdict.isClean && isRestored;

      if (stoppedBecause !== null) {
        break;
      }
    }

    if (isOffRunSettings && stoppedBecause === null) {
      const restored = await resetRunSettings(deps, name);

      isPassed &&= restored.isRestored;
      stoppedBecause = restored.stoppedBecause;
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

// the suite's settings, null for the run's, or undefined when reading them
// threw, which fails the suite before it changes anything
function readSettings(
  deps: Readonly<RunSuitesDeps>,
  name: string,
): Readonly<Record<string, string>> | null | undefined {
  try {
    return deps.settingsOf(name);
  } catch (error) {
    deps.log(`    the ${name} suite's settings could not be read: ${readReason(error)}`);

    return undefined;
  }
}

async function runRebootOnto(
  deps: Readonly<RunSuitesDeps>,
  name: string,
  settings: Readonly<Record<string, string>>,
): Promise<boolean> {
  try {
    await deps.rebootOnto(settings);

    return true;
  } catch (error) {
    deps.log(
      `    the instance could not reboot onto the ${name} suite's settings: ${readReason(error)}`,
    );

    return false;
  }
}

interface SettingsRestore {
  readonly isRestored: boolean;
  readonly stoppedBecause: string | null;
}

// The reboot back onto the run's settings after a suite with its own; when
// it fails, a fresh instance, unless the run was interrupted.
async function resetRunSettings(
  deps: Readonly<RunSuitesDeps>,
  name: string,
): Promise<SettingsRestore> {
  try {
    await deps.reboot();

    return { isRestored: true, stoppedBecause: null };
  } catch (error) {
    deps.log(
      `    the instance could not reboot off the ${name} suite's settings: ${readReason(error)}`,
    );
  }

  if (deps.isInterrupted()) {
    return { isRestored: false, stoppedBecause: null };
  }

  try {
    await deps.recreate();

    return { isRestored: false, stoppedBecause: null };
  } catch (error) {
    return {
      isRestored: false,
      stoppedBecause: `the instance could not be made anew after the ${name} suite: ${readReason(error)}`,
    };
  }
}

interface RestoreOptions {
  readonly prefixes: readonly string[];

  // --keep, or scale's imps kept for restart
  readonly isSkipped: boolean;

  // the reboot after a failure: onto the suite's settings, or the run's
  readonly reboot: () => Promise<void>;
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
      await options.reboot();
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
