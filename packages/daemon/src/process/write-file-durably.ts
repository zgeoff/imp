import {
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DurableWriteOptions {
  // the new file's mode; 0o644 by default
  readonly mode?: number;

  // flushes one open file or directory to the disk; fsync by default, and a
  // test passes a recorder that calls it
  readonly sync?: (fd: number) => void;
}

// a new file, never one that is there, and never through a symlink
const NEW_FILE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

// Writes `data` to `<path>.new`, flushes it, renames it over `path` and
// flushes the directory: after a crash the file is the old one or the new
// one, never part of either, and the new one outlives a power loss.
export function writeFileDurably(
  path: string,
  data: string | Uint8Array,
  options: DurableWriteOptions = {},
): void {
  const next = `${path}.new`;
  const sync = options.sync ?? fsyncSync;

  rmSync(next, { force: true });

  try {
    const file = openSync(next, NEW_FILE_FLAGS, options.mode ?? 0o644);

    try {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      let written = 0;

      while (written < bytes.length) {
        written += writeSync(file, bytes, written);
      }

      sync(file);
    } finally {
      closeSync(file);
    }

    renameSync(next, path);
  } finally {
    rmSync(next, { force: true });
  }

  // the rename itself lives in the directory
  writeToDisk([dirname(path)], sync);
}

// writeFileDurably's twin for a caller that must not block the event loop
export async function writeFileDurablyAsync(
  path: string,
  data: string | Uint8Array,
  options: Omit<DurableWriteOptions, 'sync'> = {},
): Promise<void> {
  const next = `${path}.new`;

  await rm(next, { force: true });

  try {
    const file = await open(next, NEW_FILE_FLAGS, options.mode ?? 0o644);

    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }

    await rename(next, path);
  } finally {
    await rm(next, { force: true });
  }

  const dir = await open(dirname(path), 'r');

  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

// Copies `from` over `to` as writeFileDurably writes: a flushed copy at
// `<to>.new`, renamed over, then the directory flushed.
export function writeCopyDurably(from: string, to: string): void {
  const next = `${to}.new`;

  rmSync(next, { force: true });

  try {
    copyFileSync(from, next, constants.COPYFILE_EXCL);
    writeToDisk([next]);
    renameSync(next, to);
  } finally {
    rmSync(next, { force: true });
  }

  writeToDisk([dirname(to)]);
}

// Renames `from` to `to` and flushes the directory, so the new name outlives
// a power loss.
export function writeRenamed(from: string, to: string): void {
  renameSync(from, to);
  writeToDisk([dirname(to)]);
}

// Flushes each file or directory from the page cache to the disk: written
// files, and the directories whose renames hold them.
export function writeToDisk(
  paths: readonly string[],
  sync: (fd: number) => void = fsyncSync,
): void {
  for (const path of paths) {
    const fd = openSync(path, 'r');

    try {
      sync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
