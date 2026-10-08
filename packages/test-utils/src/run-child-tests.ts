import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface ChildTestRun {
  readonly exitCode: number;
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
  });

  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}
