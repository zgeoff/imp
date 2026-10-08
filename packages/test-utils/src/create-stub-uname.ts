import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface StubUnameOptions {
  // the directory the `uname` script goes in, ahead of the real one on PATH
  readonly bin: string;

  // what `uname -s` and `uname -m` print
  readonly system: string;
  readonly machine: string;
}

// A `uname` that names the platform a script picks its download by; any
// other flag fails.
export function createStubUname(options: StubUnameOptions): void {
  writeFileSync(
    join(options.bin, 'uname'),
    [
      '#!/bin/sh',
      `[ "$1" = -s ] && echo '${options.system}' && exit 0`,
      `[ "$1" = -m ] && echo '${options.machine}' && exit 0`,
      'exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}
