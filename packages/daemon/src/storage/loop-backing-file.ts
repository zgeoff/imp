import { readFileSync, realpathSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// where procfs and sysfs are mounted
export interface LoopHostDirs {
  readonly procDir: string;
  readonly sysDir: string;
}

const HOST_DIRS: LoopHostDirs = { procDir: '/proc', sysDir: '/sys' };

// The file behind the loop device mounted on `dir`, from mountinfo and the
// loop driver's sysfs; null for any other mount, or when either is unreadable.
export function findLoopBackingFile(
  dir: string,
  hostDirs: Readonly<LoopHostDirs> = HOST_DIRS,
): string | null {
  try {
    const target = realpathSync(dir);
    const mountInfo = readFileSync(join(hostDirs.procDir, 'self', 'mountinfo'), 'utf8');

    for (const line of mountInfo.split('\n')) {
      // <id> <parent> <dev> <root> <mount point> ... - <fstype> <source> ...
      const [mounts = '', fields = ''] = line.split(' - ');
      const mountPoint = mounts.split(' ').at(4);
      const [, source = ''] = fields.split(' ');
      const loop = /^\/dev\/(?<name>loop\d+)$/.exec(source)?.groups?.['name'];

      if (mountPoint === target && loop !== undefined) {
        const backing = join(hostDirs.sysDir, 'block', loop, 'loop', 'backing_file');

        return readFileSync(backing, 'utf8').trim();
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
export function readLoopHostFreeBytes(
  dir: string,
  hostDirs: Readonly<LoopHostDirs> = HOST_DIRS,
): number | null {
  const backing = findLoopBackingFile(dir, hostDirs);

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
