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

export interface ZfsCommands {
  // every filesystem and snapshot under `root`, oldest first
  readonly list: (root: string) => Promise<ZfsEntry[]>;
  readonly create: (name: string, properties?: Readonly<Record<string, string>>) => Promise<void>;
  readonly snapshot: (name: string) => Promise<void>;
  readonly clone: (snapshot: string, target: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly promote: (name: string) => Promise<void>;
  readonly destroy: (name: string) => Promise<void>;
  readonly destroyDeferred: (snapshot: string) => Promise<void>;

  // bytes written to the dataset between the previous snapshot and this one
  readonly readWritten: (snapshot: string) => Promise<number>;
  readonly readUsage: (name: string) => Promise<{ used: number; available: number }>;

  // the userland version, such as 2.2.2-0ubuntu9
  readonly readVersion: () => Promise<string>;

  // legacy mountpoints: impd mounts every dataset itself
  readonly mount: (name: string, dir: string) => Promise<void>;
  readonly unmount: (dir: string) => Promise<void>;
}

const LIST_COLUMNS = 'name,type,origin,defer_destroy';

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
    create: (name, properties = {}) => {
      const options = Object.entries(properties).flatMap(([key, value]) => [
        '-o',
        `${key}=${value}`,
      ]);

      return runQuiet(['zfs', 'create', ...options, name]);
    },
    snapshot: (name) => runQuiet(['zfs', 'snapshot', name]),
    clone: (snapshot, target) => runQuiet(['zfs', 'clone', snapshot, target]),
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
    readVersion: async () => {
      const stdout = await runChecked(['zfs', 'version']);

      return parseZfsVersion(stdout);
    },
    mount: (name, dir) => runQuiet(['mount', '-t', 'zfs', name, dir]),
    unmount: (dir) => runQuiet(['umount', dir]),
  };
}

// `zfs list -H` output: one tab-separated row per dataset, `-` for no value
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

// 2.2.2-0ubuntu9 → 2.2: the userland and the module must agree on it
export function readMajorMinor(version: string): string {
  return /^\d+\.\d+/.exec(version.trim())?.[0] ?? version.trim();
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
