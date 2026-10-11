import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface ChildTestRun {
  // null when the run was killed at its deadline
  readonly exitCode: number | null;
  readonly isTimedOut: boolean;
  readonly output: string;
}

// Runs `source` as one test file in `dir`, its working and temp dir, with no
// preload, so a later test can read what an earlier onTestFinished left. It
// kills the child at timeoutMs, by default under bun test's 5 s timeout.
export function runChildTests(dir: string, source: string, timeoutMs = 4000): ChildTestRun {
  writeFileSync(join(dir, 'child.test.ts'), source);

  const result = Bun.spawnSync([process.execPath, 'test', './child.test.ts'], {
    cwd: dir,
    env: { ...process.env, TMPDIR: dir },
    timeout: timeoutMs,
  });

  return {
    exitCode: result.exitCode,
    isTimedOut: result.exitedDueToTimeout === true,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}
