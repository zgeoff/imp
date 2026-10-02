import { readFileSync, realpathSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';

interface LoopFiles {
  readonly readText: (path: string) => string;
  readonly resolvePath: (path: string) => string;
}

const HOST_FILES: LoopFiles = {
  readText: (path) => readFileSync(path, 'utf8'),
  resolvePath: (path) => realpathSync(path),
};

// The file behind the loop device mounted on `dir`, from mountinfo and the
// loop driver's sysfs; null for any other mount, or when either is unreadable.
export function findLoopBackingFile(dir: string, files: LoopFiles = HOST_FILES): string | null {
  try {
    const target = files.resolvePath(dir);

    for (const line of files.readText('/proc/self/mountinfo').split('\n')) {
      // <id> <parent> <dev> <root> <mount point> ... - <fstype> <source> ...
      const [mounts = '', fields = ''] = line.split(' - ');
      const mountPoint = mounts.split(' ').at(4);
      const [, source = ''] = fields.split(' ');
      const loop = /^\/dev\/(?<name>loop\d+)$/.exec(source)?.groups?.['name'];

      if (mountPoint === target && loop !== undefined) {
        return files.readText(`/sys/block/${loop}/loop/backing_file`).trim();
      }
    }
  } catch {
    // no mountinfo or sysfs: the filesystem's own count stands
  }

  return null;
}

// Free bytes in the directory that holds the loop file behind `dir`: the
// filesystem inside can report room its sparse file can no longer get. null
// when `dir` is no loop mount, or the host directory cannot be read.
export function readLoopHostFreeBytes(dir: string): number | null {
  const backing = findLoopBackingFile(dir);

  if (backing === null) {
    return null;
  }

  try {
    const host = statfsSync(dirname(backing));

    return host.bavail * host.bsize;
  } catch {
    return null;
  }
}
