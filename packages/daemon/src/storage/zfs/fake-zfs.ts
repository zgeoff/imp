import type { CommandResult } from '../../process/run-command';

interface FakeDataset {
  origin: string | null;
  readonly txg: number;
  readonly properties?: Readonly<Record<string, string>>;
}

interface FakeSnapshot {
  readonly txg: number;
  deferDestroy: boolean;
}

interface FakeZfsOptions {
  readonly root: string;

  // where the root dataset is mounted, as setup-storage.sh mounts it
  readonly rootDir: string;
  readonly userland?: string;
  readonly kernel?: string;
}

export class FakeZfsCrashError extends Error {
  override name = 'FakeZfsCrashError';
}

function buildFailure(message: string): CommandResult {
  return { exitCode: 1, stdout: '', stderr: message };
}

function buildSuccess(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function findParent(name: string): string {
  return name.slice(0, name.lastIndexOf('/'));
}

// An in-memory ZFS: clones, promote, deferred destroy and legacy mounts, with
// the errors real ZFS gives where impd could trip. It answers impd's argv in
// the real `-H` format and records each command.
export function createFakeZfs(options: FakeZfsOptions) {
  const datasets = new Map<string, FakeDataset>();
  const snapshots = new Map<string, FakeSnapshot>();
  const mounts = new Map<string, string>();
  const readOnlyDirs = new Set<string>();

  const commands: string[] = [];
  const gates: { match: (command: string) => boolean; opened: Promise<void> }[] = [];
  const failures: ((command: string) => boolean)[] = [];
  const state = { txg: 1, crashAt: null as ((command: string) => boolean) | null, crashed: false };

  datasets.set(options.root, { origin: null, txg: 0 });
  mounts.set(options.rootDir, options.root);

  const findSnapshotsOf = (dataset: string) =>
    [...snapshots.keys()].filter((name) => name.startsWith(`${dataset}@`));

  const findClonesOf = (snapshot: string) =>
    [...datasets.entries()]
      .filter(([, dataset]) => dataset.origin === snapshot)
      .map(([name]) => name);

  const isMounted = (name: string) => [...mounts.values()].includes(name);

  // a marked snapshot goes with its last clone
  const removeUnusedDeferred = (snapshot: string | null) => {
    const found = snapshot === null ? undefined : snapshots.get(snapshot);

    if (snapshot !== null && found?.deferDestroy === true && findClonesOf(snapshot).length === 0) {
      snapshots.delete(snapshot);
    }
  };

  const updateSnapshotName = (from: string, to: string) => {
    const snapshot = snapshots.get(from);

    if (snapshot !== undefined) {
      snapshots.delete(from);
      snapshots.set(to, snapshot);
    }

    for (const dataset of datasets.values()) {
      if (dataset.origin === from) {
        dataset.origin = to;
      }
    }
  };

  const createDataset = (name: string): CommandResult => {
    if (datasets.has(name)) {
      return buildFailure(`cannot create '${name}': dataset already exists`);
    }

    if (!datasets.has(findParent(name))) {
      return buildFailure(`cannot create '${name}': parent does not exist`);
    }

    datasets.set(name, { origin: null, txg: state.txg++ });

    return buildSuccess();
  };

  const createSnapshot = (name: string): CommandResult => {
    const [dataset = ''] = name.split('@');

    if (!datasets.has(dataset)) {
      return buildFailure(`cannot open '${dataset}': dataset does not exist`);
    }

    if (snapshots.has(name)) {
      return buildFailure(`cannot create snapshot '${name}': dataset already exists`);
    }

    snapshots.set(name, { txg: state.txg++, deferDestroy: false });

    return buildSuccess();
  };

  const createClone = (
    origin: string,
    target: string,
    properties: Readonly<Record<string, string>>,
  ): CommandResult => {
    if (!snapshots.has(origin)) {
      return buildFailure(`cannot open '${origin}': dataset does not exist`);
    }

    if (datasets.has(target)) {
      return buildFailure(`cannot create '${target}': dataset already exists`);
    }

    if (!datasets.has(findParent(target))) {
      return buildFailure(`cannot create '${target}': parent does not exist`);
    }

    datasets.set(target, { origin, txg: state.txg++, properties });

    return buildSuccess();
  };

  const updateDatasetName = (from: string, to: string): CommandResult => {
    const dataset = datasets.get(from);

    if (dataset === undefined) {
      return buildFailure(`cannot open '${from}': dataset does not exist`);
    }

    if (datasets.has(to) || !datasets.has(findParent(to))) {
      return buildFailure(
        `cannot rename to '${to}': dataset already exists or parent does not exist`,
      );
    }

    if ([...datasets.keys()].some((name) => name.startsWith(`${from}/`))) {
      return buildFailure(`fake zfs: impd never renames a dataset with children (${from})`);
    }

    if (isMounted(from)) {
      return buildFailure(`fake zfs: impd unmounts before a rename (${from})`);
    }

    datasets.delete(from);
    datasets.set(to, dataset);

    for (const name of findSnapshotsOf(from)) {
      updateSnapshotName(name, `${to}${name.slice(from.length)}`);
    }

    return buildSuccess();
  };

  // the clone takes over its origin snapshot and every older one; the old
  // parent becomes a clone of the origin
  const runPromote = (name: string): CommandResult => {
    const promoted = datasets.get(name);

    if (promoted?.origin === undefined || promoted.origin === null) {
      return buildFailure(`cannot promote '${name}': not a cloned filesystem`);
    }

    const origin = promoted.origin;
    const [parentName = ''] = origin.split('@');
    const parent = datasets.get(parentName);
    const originTxg = snapshots.get(origin)?.txg ?? 0;

    if (parent === undefined) {
      return buildFailure(`fake zfs: the parent of ${origin} is gone`);
    }

    const moving = findSnapshotsOf(parentName).filter(
      (snapshotName) => (snapshots.get(snapshotName)?.txg ?? 0) <= originTxg,
    );

    for (const snapshotName of moving) {
      if (snapshots.has(`${name}${snapshotName.slice(parentName.length)}`)) {
        return buildFailure(`cannot promote '${name}': snapshot name conflict`);
      }
    }

    promoted.origin = parent.origin;

    for (const snapshotName of moving) {
      updateSnapshotName(snapshotName, `${name}${snapshotName.slice(parentName.length)}`);
    }

    parent.origin = `${name}${origin.slice(parentName.length)}`;

    return buildSuccess();
  };

  const runDestroy = (name: string, deferred: boolean): CommandResult => {
    if (name.includes('@')) {
      if (!snapshots.has(name)) {
        return buildFailure(`could not find any snapshots to destroy; check snapshot names.`);
      }

      if (findClonesOf(name).length > 0) {
        if (!deferred) {
          return buildFailure(`cannot destroy '${name}': snapshot has dependent clones`);
        }

        snapshots.set(name, { txg: snapshots.get(name)?.txg ?? 0, deferDestroy: true });

        return buildSuccess();
      }

      snapshots.delete(name);

      return buildSuccess();
    }

    const dataset = datasets.get(name);

    if (dataset === undefined) {
      return buildFailure(`cannot open '${name}': dataset does not exist`);
    }

    if (
      findSnapshotsOf(name).length > 0 ||
      [...datasets.keys()].some((other) => other.startsWith(`${name}/`))
    ) {
      return buildFailure(`cannot destroy '${name}': filesystem has children`);
    }

    if (isMounted(name)) {
      return buildFailure(`cannot destroy '${name}': dataset is busy`);
    }

    datasets.delete(name);

    removeUnusedDeferred(dataset.origin);

    return buildSuccess();
  };

  const listTree = (root: string): CommandResult => {
    const isInTree = (name: string) => name === root || name.startsWith(`${root}/`);

    const rows = [
      ...[...datasets.entries()]
        .filter(([name]) => isInTree(name))
        .map(([name, dataset]) => ({
          txg: dataset.txg,
          line: `${name}\tfilesystem\t${dataset.origin ?? '-'}\t-`,
        })),
      ...[...snapshots.entries()]
        .filter(([name]) => isInTree(name.split('@')[0] ?? ''))
        .map(([name, found]) => ({
          txg: found.txg,
          line: `${name}\tsnapshot\t-\t${found.deferDestroy ? 'on' : 'off'}`,
        })),
    ].toSorted((a, b) => a.txg - b.txg);

    return buildSuccess(rows.map((row) => `${row.line}\n`).join(''));
  };

  const handleCommand = (argv: readonly string[]): CommandResult => {
    const [tool = '', verb = '', ...rest] = argv;
    const last = argv.at(-1) ?? '';

    // mount -t zfs [-o ro] <name> <dir>; like a real legacy mount, the
    // readonly property does not make it read-only
    if (tool === 'mount') {
      const name = argv.at(-2) ?? '';
      const dir = last;

      if (!datasets.has(name)) {
        return buildFailure(`mount: ${dir}: ${name} does not exist`);
      }

      if (mounts.has(dir)) {
        return buildFailure(`mount: ${dir}: already mounted`);
      }

      mounts.set(dir, name);

      if (rest.includes('ro')) {
        readOnlyDirs.add(dir);
      }

      return buildSuccess();
    }

    if (tool === 'umount') {
      readOnlyDirs.delete(verb);

      if (!mounts.delete(verb)) {
        return buildFailure(`umount: ${verb}: not mounted.`);
      }

      return buildSuccess();
    }

    if (verb === 'version') {
      return buildSuccess(
        `zfs-${options.userland ?? '2.2.2-0ubuntu9'}\nzfs-kmod-${options.kernel ?? '2.2.2-0ubuntu9'}\n`,
      );
    }

    if (verb === 'list' && argv.includes('used,available')) {
      return buildSuccess('1073741824\t9663676416\n');
    }

    if (verb === 'list') {
      return listTree(last);
    }

    if (verb === 'get') {
      return snapshots.has(last)
        ? buildSuccess('65536\n')
        : buildFailure(`cannot open '${last}': dataset does not exist`);
    }

    if (verb === 'create') {
      return createDataset(last);
    }

    if (verb === 'snapshot') {
      return createSnapshot(last);
    }

    // zfs clone [-o key=value]… <snapshot> <target>
    if (verb === 'clone') {
      const properties: Record<string, string> = {};

      for (const [index, arg] of rest.entries()) {
        const [key = '', value = ''] = arg.split('=');

        if (rest[index - 1] === '-o') {
          properties[key] = value;
        }
      }

      return createClone(argv.at(-2) ?? '', last, properties);
    }

    if (verb === 'rename') {
      return updateDatasetName(rest[0] ?? '', last);
    }

    if (verb === 'promote') {
      return runPromote(last);
    }

    if (verb === 'destroy') {
      return runDestroy(last, rest[0] === '-d');
    }

    return buildFailure(`fake zfs: unknown command ${argv.join(' ')}`);
  };

  return {
    commands,

    run: async (argv: readonly string[]): Promise<CommandResult> => {
      const command = argv.join(' ');

      if (state.crashed || state.crashAt?.(command) === true) {
        state.crashed = true;
        throw new FakeZfsCrashError(`crashed before ${command}`);
      }

      for (const gate of gates.filter((candidate) => candidate.match(command))) {
        await gate.opened;
      }

      const failure = failures.findIndex((match) => match(command));

      if (failure !== -1) {
        failures.splice(failure, 1);

        return buildFailure(`fake zfs: ${command} failed`);
      }

      commands.push(command);

      return handleCommand(argv);
    },

    // matching commands wait until the returned function runs
    blockBefore: (match: (command: string) => boolean) => {
      const gate = Promise.withResolvers<void>();

      gates.push({ match, opened: gate.promise });

      return () => {
        gate.resolve();
      };
    },

    // the next matching command exits 1 and changes nothing
    failOnce: (match: (command: string) => boolean) => {
      failures.push(match);
    },

    readMounts: () =>
      [...mounts.entries()]
        .map(
          ([dir, name]) =>
            `${name} ${dir.replaceAll(' ', String.raw`\040`)} zfs ${readOnlyDirs.has(dir) ? 'ro' : 'rw'},noatime,xattr,noacl 0 0\n`,
        )
        .join(''),

    // every later command fails, as if impd died just before the matching one
    crashBefore: (match: (command: string) => boolean) => {
      state.crashAt = match;
    },

    // a new impd on the same pool; mounts made in the container survive only
    // a restart of impd, so `dropMounts` models a container restart
    restart: (dropMounts = false) => {
      state.crashAt = null;
      state.crashed = false;

      if (dropMounts) {
        for (const dir of mounts.keys()) {
          if (dir !== options.rootDir) {
            mounts.delete(dir);
          }
        }
      }
    },

    listDatasets: () => [...datasets.keys()].toSorted(),
    listSnapshots: () => [...snapshots.keys()].toSorted(),
    readOrigin: (name: string) => datasets.get(name)?.origin ?? null,
    readProperty: (name: string, key: string) => datasets.get(name)?.properties?.[key] ?? null,
    isDeferred: (name: string) => snapshots.get(name)?.deferDestroy ?? false,
    readMountedAt: (dir: string) => mounts.get(dir) ?? null,
    isReadOnlyAt: (dir: string) => readOnlyDirs.has(dir),
  };
}
