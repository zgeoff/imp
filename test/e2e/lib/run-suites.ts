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

    const exitCode = await deps.runSuite(name);
    const isClean = await deps.checkSuite(name);

    const prefix = deps.prefixOf(name);
    const isKeptForRestart = name === 'scale' && deps.names.includes('restart');
    const prefixes = [prefix, ...carried];

    carried = isKeptForRestart ? [prefix] : [];

    let isRestored = true;
    let stoppedBecause: string | null = null;

    if (!deps.keep && !isKeptForRestart) {
      try {
        if (exitCode !== 0 && !deps.isInterrupted()) {
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

        // a fresh instance holds nothing to carry
        carried = [];
      } catch (error) {
        stoppedBecause = `the instance could not be made anew after ${name}: ${readReason(error)}`;
      }
    }

    const result = {
      name,
      passed: exitCode === 0 && isClean && isRestored,
      ms: deps.now() - started,
    };

    results.push(result);
    deps.onSuiteEnd(result);

    if (stoppedBecause !== null) {
      return { results, stoppedBecause };
    }
  }

  return { results, stoppedBecause: null };
}
