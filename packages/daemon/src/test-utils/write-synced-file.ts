import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';

// Writes `text` and fsyncs the one file, so a snapshot taken next holds it;
// a `sync` would flush every filesystem on the runner.
export function writeSyncedFile(path: string, text: string): void {
  const fd = openSync(path, 'w');

  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
