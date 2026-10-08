import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// under bun test's default 5 s test timeout, so the parent reports a hung child
const CHILD_TIMEOUT_MS = 4000;

interface ChildTestRun {
  // null when the run was killed at its deadline
  readonly exitCode: number | null;
  readonly isTimedOut: boolean;
  readonly output: string;
}

// Writes `source` as one test file in `dir` and runs it with `bun test`, with
// `dir` as its working and temp dir and no preload, so a later test there can
// read what an earlier test's onTestFinished left.
export function runChildTests(dir: string, source: string): ChildTestRun {
  writeFileSync(join(dir, 'child.test.ts'), source);

  const result = Bun.spawnSync([process.execPath, 'test', './child.test.ts'], {
    cwd: dir,
    env: { ...process.env, TMPDIR: dir },
    timeout: CHILD_TIMEOUT_MS,
  });

  return {
    exitCode: result.exitCode,
    isTimedOut: result.exitedDueToTimeout === true,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}
