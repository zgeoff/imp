import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolveConfigDir } from './host-store';
import type { CliEnv } from './host-store';

// what the CLI keeps in its config directory: the saved hosts and the
// fallback token (cli-config.ts)
const CONFIG_FILES = ['config.json', 'token'] as const;

// The CLI kept its files in <config>/imp before its rename to impz.
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
    const from = join(legacyDir, name);
    const to = join(dir, name);
    const target = findRelativeLinkTarget(from);

    if (target === null) {
      renameSync(from, to);
    } else {
      symlinkSync(planLinkTarget(target, legacyDir, dir, files), to);
      unlinkSync(from);
    }

    warn(`impz: moved ${from} to ${to}`);
  }

  // the old directory goes only when nothing else is left in it
  try {
    rmdirSync(legacyDir);
  } catch {
    // not empty, or not ours to remove
  }
}

// a relative symlink's target, which a plain rename would leave pointing
// into the new directory; null for a file or an absolute link
function findRelativeLinkTarget(path: string): string | null {
  if (!lstatSync(path).isSymbolicLink()) {
    return null;
  }

  const target = readlinkSync(path);

  return isAbsolute(target) ? null : target;
}

// the same file, as seen from the new directory: a moved one at its new
// place, anything else where it was
function planLinkTarget(
  target: string,
  legacyDir: string,
  dir: string,
  files: readonly string[],
): string {
  const absolute = resolve(legacyDir, target);
  const isMoved = dirname(absolute) === resolve(legacyDir) && files.includes(basename(absolute));
  const file = isMoved ? join(dir, basename(absolute)) : absolute;

  return relative(dir, file);
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
