import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface StubShasumOptions {
  // the directory the `shasum` script goes in
  readonly bin: string;
}

export interface StubShasum {
  // the arguments of each call, in order
  readonly readCalls: () => readonly string[];
}

// macOS's `shasum -a 256 <file>` (run-stub-shasum.sh), answered by this
// machine's sha256sum by its full path, for a PATH without sha256sum; each
// call's arguments are recorded beside the script.
export function createStubShasum(options: StubShasumOptions): StubShasum {
  const sha256sum = Bun.which('sha256sum', { PATH: process.env['PATH'] ?? '' });

  if (sha256sum === null) {
    throw new Error('sha256sum is not on PATH');
  }

  const log = join(options.bin, 'shasum.calls');

  writeFileSync(log, '');
  writeFileSync(join(options.bin, 'shasum.sha256sum'), `${sha256sum}\n`);
  copyFileSync(join(import.meta.dir, 'run-stub-shasum.sh'), join(options.bin, 'shasum'));
  chmodSync(join(options.bin, 'shasum'), 0o755);

  return {
    readCalls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
  };
}
