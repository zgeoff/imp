import { lstatSync, mkdirSync, renameSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveConfigDir } from './host-store';
import type { CliEnv } from './host-store';

// what the CLI keeps in its config directory: the saved hosts and the
// fallback token (cli-config.ts)
const CONFIG_FILES = ['config.json', 'token'] as const;

// The CLI kept its files in <config>/imp before its rename to impz. A moved
// symlink stays one, and still resolves: the two directories are siblings.
export function updateLegacyConfig(
  env: CliEnv,
  warn: (line: string) => void = console.error,
): void {
  const dir = resolveConfigDir(env);
  const legacyDir = join(dirname(dir), 'imp');

  if (isPresent(dir)) {
    return;
  }

  const files = CONFIG_FILES.filter((name) => isPresent(join(legacyDir, name)));

  if (files.length === 0) {
    return;
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  for (const name of files) {
    renameSync(join(legacyDir, name), join(dir, name));
    warn(`impz: moved ${join(legacyDir, name)} to ${join(dir, name)}`);
  }

  // the old directory goes only when nothing else is left in it
  try {
    rmdirSync(legacyDir);
  } catch {
    // not empty, or not ours to remove
  }
}

// lstat, so a symlink counts even when its target is gone
function isPresent(path: string): boolean {
  try {
    lstatSync(path);

    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}
