import { readFileSync } from 'node:fs';

// one line of /proc/self/mounts
export interface MountEntry {
  readonly source: string;
  readonly target: string;
  readonly fstype: string;
}

// one line of /proc/<pid>/mountinfo
export interface MountInfoEntry {
  readonly mountPoint: string;
  readonly fstype: string;
  readonly source: string;
}

// The host's mount table, as /proc/self/mounts lists it.
export function readMounts(): string {
  return readFileSync('/proc/self/mounts', 'utf8');
}

// Each line of a /proc/self/mounts table, with the octal escapes the kernel
// writes for a space, a tab, a newline and a backslash decoded.
export function parseMounts(mounts: string): MountEntry[] {
  return mounts
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [source = '', target = '', fstype = ''] = line.split(' ');

      return { source: decodeMountField(source), target: decodeMountField(target), fstype };
    });
}

// Each line of a mountinfo table:
// <id> <parent> <dev> <root> <mount point> <options> [<optional>...] - <fstype> <source> ...
export function parseMountInfo(mountInfo: string): MountInfoEntry[] {
  return mountInfo
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [mounts = '', fields = ''] = line.split(' - ');
      const [fstype = '', source = ''] = fields.split(' ');

      return {
        mountPoint: decodeMountField(mounts.split(' ').at(4) ?? ''),
        fstype,
        source: decodeMountField(source),
      };
    });
}

function decodeMountField(field: string): string {
  return field.replaceAll(/\\(?<octal>[0-7]{3})/gu, (_match, octal: string) =>
    String.fromCodePoint(Number.parseInt(octal, 8)),
  );
}
