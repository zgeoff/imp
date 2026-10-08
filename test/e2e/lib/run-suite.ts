export interface RunSuiteOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;

  // the suite's pid, once it runs, which leads its process group
  readonly onStart: (pid: number) => void;

  // brings impd back to the baseline once the process ends with this code,
  // whether it passed, failed or was stopped; null leaves what it made
  // (--keep, or scale's imps for restart)
  readonly reset: ((exitCode: number) => Promise<void>) | null;
}

export interface SuiteOutcome {
  readonly exitCode: number;

  // why the reset failed, or null when it passed or did not run
  readonly resetError: string | null;
}

// Runs one suite file as its own process group, then resets the baseline,
// so a suite that fails or is stopped leaves nothing for the next.
export async function runSuite(options: Readonly<RunSuiteOptions>): Promise<SuiteOutcome> {
  const proc = Bun.spawn([...options.argv], {
    cwd: options.cwd,
    detached: true,
    stdout: 'inherit',
    stderr: 'inherit',
    env: options.env,
  });

  options.onStart(proc.pid);

  const exitCode = await proc.exited;

  if (options.reset === null) {
    return { exitCode, resetError: null };
  }

  const resetError = await options.reset(exitCode).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  return { exitCode, resetError };
}
