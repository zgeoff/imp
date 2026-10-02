import type { CommandResult } from '../../process/run-command';

// runCommand in impd; a fake ZFS in tests
export type CommandRunner = (argv: readonly string[]) => Promise<CommandResult>;

export interface ZfsEntry {
  readonly name: string;
  readonly type: 'filesystem' | 'snapshot';

  // a filesystem's: the snapshot it is a clone of
  readonly origin: string | null;

  // a snapshot's: `zfs destroy -d` marked it, and it goes with its last clone
  readonly deferDestroy: boolean;
}

interface MountOptions {
  readonly isReadOnly: boolean;
}

export interface ZfsCommands {
  // every filesystem and snapshot under `root`, oldest first
  readonly list: (root: string) => Promise<ZfsEntry[]>;
  readonly create: (name: string, properties?: Readonly<Record<string, string>>) => Promise<void>;
  readonly snapshot: (name: string) => Promise<void>;
  readonly clone: (
    snapshot: string,
    target: string,
    properties?: Readonly<Record<string, string>>,
  ) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly promote: (name: string) => Promise<void>;
  readonly destroy: (name: string) => Promise<void>;
  readonly destroyDeferred: (snapshot: string) => Promise<void>;

  // bytes written to the dataset between the previous snapshot and this one
  readonly readWritten: (snapshot: string) => Promise<number>;
  readonly readUsage: (name: string) => Promise<{ used: number; available: number }>;

  // every dataset and snapshot under root with its space properties
  readonly listSpace: (root: string) => Promise<ZfsSpace[]>;

  // the userland version, such as 2.2.2-0ubuntu9
  readonly readVersion: () => Promise<string>;

  // legacy mountpoints: impd mounts every dataset itself. A legacy mount
  // ignores the readonly property, so a read-only mount says so itself.
  readonly mount: (name: string, dir: string, options?: MountOptions) => Promise<void>;
  readonly unmount: (dir: string) => Promise<void>;
}

const LIST_COLUMNS = 'name,type,origin,defer_destroy';
const SPACE_COLUMNS = 'name,used,referenced,usedbydataset,creation,clones';

// A dataset's or snapshot's space. `used` of a dataset counts its snapshots;
// of a snapshot, the blocks only it holds. A snapshot has no usedbydataset.
export interface ZfsSpace {
  readonly name: string;
  readonly used: number;
  readonly referenced: number;
  readonly usedByDataset: number;

  // `creation`, which `-p` gives in seconds since the epoch
  readonly createdAt: Date;

  // the clones of a snapshot: forks, a restore, a backup tree
  readonly clones: readonly string[];
}

export function createZfsCommands(run: CommandRunner): ZfsCommands {
  const runChecked = async (argv: readonly string[]): Promise<string> => {
    const result = await run(argv);

    if (result.exitCode !== 0) {
      throw new Error(
        `${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }

    return result.stdout;
  };

  const runQuiet = async (argv: readonly string[]): Promise<void> => {
    await runChecked(argv);
  };

  return {
    list: async (root) => {
      const stdout = await runChecked([
        'zfs',
        'list',
        '-Hp',
        '-r',
        '-t',
        'filesystem,snapshot',
        '-s',
        'createtxg',
        '-o',
        LIST_COLUMNS,
        root,
      ]);

      return parseZfsList(stdout);
    },
    create: (name, properties = {}) =>
      runQuiet(['zfs', 'create', ...buildPropertyArgs(properties), name]),
    snapshot: (name) => runQuiet(['zfs', 'snapshot', name]),
    clone: (snapshot, target, properties = {}) =>
      runQuiet(['zfs', 'clone', ...buildPropertyArgs(properties), snapshot, target]),
    rename: (from, to) => runQuiet(['zfs', 'rename', from, to]),
    promote: (name) => runQuiet(['zfs', 'promote', name]),
    destroy: (name) => runQuiet(['zfs', 'destroy', name]),
    destroyDeferred: (snapshot) => runQuiet(['zfs', 'destroy', '-d', snapshot]),
    readWritten: async (snapshot) => {
      const stdout = await runChecked(['zfs', 'get', '-Hp', '-o', 'value', 'written', snapshot]);

      return parseBytes(stdout.trim());
    },
    readUsage: async (name) => {
      const stdout = await runChecked(['zfs', 'list', '-Hp', '-o', 'used,available', name]);

      const [used = '', available = ''] = stdout.trim().split('\t');

      return { used: parseBytes(used), available: parseBytes(available) };
    },
    listSpace: async (root) => {
      const stdout = await runChecked([
        'zfs',
        'list',
        '-Hp',
        '-r',
        '-t',
        'filesystem,snapshot',
        '-o',
        SPACE_COLUMNS,
        root,
      ]);

      return parseZfsSpace(stdout);
    },
    readVersion: async () => {
      const stdout = await runChecked(['zfs', 'version']);

      return parseZfsVersion(stdout);
    },
    mount: (name, dir, options) =>
      runQuiet([
        'mount',
        '-t',
        'zfs',
        ...(options?.isReadOnly === true ? ['-o', 'ro'] : []),
        name,
        dir,
      ]),
    unmount: (dir) => runQuiet(['umount', dir]),
  };
}

export function parseZfsSpace(stdout: string): ZfsSpace[] {
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [
        name = '',
        used = '',
        referenced = '',
        usedByDataset = '',
        creation = '',
        clones = '',
      ] = line.split('\t');

      return {
        name,
        used: parseBytes(used),
        referenced: parseBytes(referenced),
        usedByDataset: usedByDataset === '-' ? 0 : parseBytes(usedByDataset),
        createdAt: parseEpochSeconds(creation),
        clones: clones === '-' || clones === '' ? [] : clones.split(','),
      };
    });
}

// `zfs list -H` output: one tab-separated row per dataset, `-` for no value
function buildPropertyArgs(properties: Readonly<Record<string, string>>): string[] {
  return Object.entries(properties).flatMap(([key, value]) => ['-o', `${key}=${value}`]);
}

export function parseZfsList(stdout: string): ZfsEntry[] {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [name = '', type = '', origin = '-', deferDestroy = '-'] = line.split('\t');

      if (type !== 'filesystem' && type !== 'snapshot') {
        throw new Error(`zfs list: unexpected row ${JSON.stringify(line)}`);
      }

      return {
        name,
        type,
        origin: origin === '-' || origin === '' ? null : origin,
        deferDestroy: deferDestroy === 'on',
      };
    });
}

// `zfs version` prints the userland first (zfs-2.2.2-0ubuntu9), then the
// kernel module (zfs-kmod-2.2.2-0ubuntu9)
export function parseZfsVersion(stdout: string): string {
  const userland = /^zfs-(?<version>\d+\.\d+\S*)$/m.exec(stdout);
  const version = userland?.groups?.['version'];

  if (version === undefined) {
    throw new Error(`zfs version: unexpected output ${JSON.stringify(stdout.trim())}`);
  }

  return version;
}

// 2.2.2-0ubuntu9 → { major: '2', minor: '2' }
export function parseZfsRelease(version: string): { major: string; minor: string } {
  const found = /^(?<major>\d+)\.(?<minor>\d+)/.exec(version.trim())?.groups;

  return { major: found?.['major'] ?? version.trim(), minor: found?.['minor'] ?? '' };
}

// /proc/self/mounts → the ZFS dataset mounted on each directory. A space in a
// path is written \040.
export function parseZfsMounts(mounts: string): Map<string, string> {
  const found = new Map<string, string>();

  for (const line of mounts.split('\n')) {
    const [source = '', dir = '', fstype = ''] = line.split(' ');

    if (fstype === 'zfs') {
      found.set(decodeMountField(dir), decodeMountField(source));
    }
  }

  return found;
}

function decodeMountField(field: string): string {
  return field.replaceAll(/\\(?<octal>[0-7]{3})/g, (_match, octal: string) =>
    String.fromCodePoint(Number.parseInt(octal, 8)),
  );
}

function parseBytes(value: string): number {
  const bytes = Number(value);

  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`zfs: expected a byte count, got ${JSON.stringify(value)}`);
  }

  return bytes;
}

function parseEpochSeconds(value: string): Date {
  const seconds = Number(value);

  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new Error(`zfs: expected seconds since the epoch, got ${JSON.stringify(value)}`);
  }

  return new Date(seconds * 1000);
}
