import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The ksm-exec merge wrapper as an executable in `dir`: it records the
// command it was asked to exec, one argument a line, then fails as an exec
// that never started would.
export function createStubKsmExec(dir: string) {
  const path = join(dir, 'ksm-exec');
  const recorded = join(dir, 'ksm-exec.argv');

  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${recorded}'\nexit 1\n`, { mode: 0o755 });

  return {
    path,
    readArgv: (): string[] => readFileSync(recorded, 'utf8').trimEnd().split('\n'),
  };
}
