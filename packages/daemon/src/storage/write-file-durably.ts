import { closeSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// Writes `text` next to `path`, flushes it, and renames it over: after a
// crash the file is the old one or the new one, never part of either.
export function writeFileDurably(path: string, text: string): void {
  const next = `${path}.new`;
  const file = openSync(next, 'w', 0o644);

  try {
    writeSync(file, text);
    fsyncSync(file);
  } finally {
    closeSync(file);
  }

  renameSync(next, path);

  // the rename itself lives in the directory
  writeToDisk([dirname(path)]);
}

// Renames `from` to `to` and flushes the directory, so the new name outlives
// a power loss.
export function writeRenamed(from: string, to: string): void {
  renameSync(from, to);
  writeToDisk([dirname(to)]);
}

// Flushes each file or directory from the page cache to the disk: written
// files, and the directories whose renames hold them.
export function writeToDisk(paths: readonly string[]): void {
  for (const path of paths) {
    const fd = openSync(path, 'r');

    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
