export interface RunSuiteOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;

  // the suite's pid, once it runs, which leads its process group
  readonly onStart: (pid: number) => void;
}

// Runs one suite file as its own process group and returns its exit code.
export function runSuite(options: Readonly<RunSuiteOptions>): Promise<number> {
  const proc = Bun.spawn([...options.argv], {
    cwd: options.cwd,
    detached: true,
    stdout: 'inherit',
    stderr: 'inherit',
    env: options.env,
  });

  options.onStart(proc.pid);

  return proc.exited;
}

// Signals a suite's whole process group; a group already gone (ESRCH) counts
// as stopped.
export function stopSuiteGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') {
      throw error;
    }
  }
}
