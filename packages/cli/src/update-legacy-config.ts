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

// what the CLI keeps in its config directory: the saved hosts and the
// fallback token (cli-config.ts)
const CONFIG_FILES: readonly string[] = ['config.json', 'token'];

// Moves the files the CLI kept in <config>/imp before its rename into `dir`,
// each only when `dir` lacks it, so a move that failed part way resumes on
// the next call and never writes over a file impz has.
export function updateLegacyConfig(
  dir: string,
  warn: (line: string) => void = console.error,
): void {
  const legacyDir = join(dirname(dir), 'imp');

  // impz's own file first, so a complete config never needs the old path
  const files = CONFIG_FILES.filter(
    (name) => !isPresent(join(dir, name)) && checkLegacyFile(join(legacyDir, name), warn),
  );

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
      symlinkSync(planLinkTarget(readlinkSync(from), realLegacyDir, realDir), to);
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

    // copied beside the target first, so a copy cut short never stands as
    // the moved file that a later call keeps
    const temp = `${to}.tmp`;

    copyFileSync(from, temp);
    chmodSync(temp, statSync(from).mode & 0o777);
    renameSync(temp, to);
    unlinkSync(from);
  }
}

// a link's target as seen from the new directory: an absolute one as it was,
// a moved file at its new place, anything else where it was
function planLinkTarget(target: string, legacyDir: string, dir: string): string {
  if (isAbsolute(target)) {
    return target;
  }

  const absolute = resolve(legacyDir, target);
  const isMoved = dirname(absolute) === legacyDir && CONFIG_FILES.includes(basename(absolute));
  const file = isMoved ? join(dir, basename(absolute)) : absolute;

  return relative(dir, file);
}

// whether an old file is there to move; a path that cannot be looked up is
// noted and left, so it never stops a call that reads impz's own config
function checkLegacyFile(path: string, warn: (line: string) => void): boolean {
  try {
    return isPresent(path);
  } catch (error) {
    // an `imp` that is a file, not a directory, holds no old config
    if (error instanceof Error && 'code' in error && error.code === 'ENOTDIR') {
      return false;
    }

    warn(`impz: cannot look for ${path} to move it: ${String(error)}`);

    return false;
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
