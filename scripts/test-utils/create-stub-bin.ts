import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StubBin {
  // the directory that holds the stub, for the front of a child's PATH
  readonly bin: string;

  // the log every stub in dir appends its call to, one `<name> <args>` line each
  readonly calls: string;
}

// Writes an executable <dir>/bin/<name> that logs `<name> $*` to <dir>/calls, then runs
// script with the call's "$@"; script may log more through $STUB_CALLS. Stubs that share
// dir share the log, which keeps their calls in order.
export function createStubBin(dir: string, name: string, script = ''): StubBin {
  const bin = join(dir, 'bin');
  const calls = join(dir, 'calls');
  const file = join(bin, name);

  mkdirSync(bin, { recursive: true });

  if (!existsSync(calls)) {
    writeFileSync(calls, '');
  }

  writeFileSync(
    file,
    `#!/bin/bash\nSTUB_CALLS='${calls.replaceAll("'", String.raw`'\''`)}'\nprintf '%s\\n' "${name} $*" >>"$STUB_CALLS"\n${script}\n`,
  );

  chmodSync(file, 0o755);

  return { bin, calls };
}
