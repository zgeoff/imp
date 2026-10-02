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
  const dir = openSync(dirname(path), 'r');

  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
