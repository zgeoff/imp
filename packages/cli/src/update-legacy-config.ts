import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
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

  // physical paths, so a relative link resolves as the kernel resolves it even
  // when either directory is reached through a symlink
  const realLegacyDir = realpathSync(legacyDir);
  const realDir = realpathSync(dir);

  for (const name of files) {
    const from = join(legacyDir, name);
    const to = join(dir, name);

    if (lstatSync(from).isSymbolicLink()) {
      symlinkSync(planLinkTarget(readlinkSync(from), realLegacyDir, realDir, files), to);
      unlinkSync(from);
    } else {
      writeMovedFile(from, to);
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

// a rename, or a copy when the old directory is on another filesystem
function writeMovedFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EXDEV')) {
      throw error;
    }

    copyFileSync(from, to);
    chmodSync(to, statSync(from).mode & 0o777);
    unlinkSync(from);
  }
}

// a link's target as seen from the new directory: an absolute one as it was,
// a moved file at its new place, anything else where it was
function planLinkTarget(
  target: string,
  legacyDir: string,
  dir: string,
  files: readonly string[],
): string {
  if (isAbsolute(target)) {
    return target;
  }

  const absolute = resolve(legacyDir, target);
  const isMoved = dirname(absolute) === legacyDir && files.includes(basename(absolute));
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
