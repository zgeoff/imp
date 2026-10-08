import { symlinkSync } from 'node:fs';
import { join } from 'node:path';

interface CreateCommandLinksOptions {
  // the directory that becomes a script's whole PATH
  readonly bin: string;

  // the real commands the script may run, found on this process's PATH
  readonly names: readonly string[];
}

// Links each named command into `bin`, so a PATH of `bin` alone hides every
// command the list leaves out, such as gh or sha256sum.
export function createCommandLinks(options: CreateCommandLinksOptions): void {
  for (const name of options.names) {
    const path = Bun.which(name);

    if (path === null) {
      throw new Error(`${name} is not on PATH`);
    }

    symlinkSync(path, join(options.bin, name));
  }
}
