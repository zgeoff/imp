import {
  chmodSync,
  closeSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { CommandResult } from '../process/run-command';
import { readErrorMessage } from '../read-error-message';
import type { ImpPaths } from '../storage/data-layout';
import { isProcessOfUid, stopProcessOfUid } from './process-owner';
import { writeRegularFile } from './vm-files';

// The Firecracker jailer (docs/architecture/daemon.md#the-jailer): each VM in a
// chroot as its imp's own uid, with the files it opens bound in at their own
// absolute paths, so they have one path inside the jail and out.

export interface JailUser {
  readonly uid: number;
  readonly gid: number;
}

interface JailPlan {
  readonly impId: string;
  readonly user: JailUser;
  readonly paths: ImpPaths;

  // files the VM only reads, such as the kernel and the system drive
  readonly readOnlyFiles: readonly string[];
}

export interface Jails {
  // a clean chroot with its binds; the command that starts Firecracker in it
  readonly prepare: (plan: Readonly<JailPlan>) => Promise<readonly string[]>;

  // unmounts the binds once the VM is gone; nothing to do is no error
  readonly release: (impId: string) => Promise<void>;

  // run/ emptied before an unjailed start, as a prepare does: a jailed VM
  // of the imp may have left anything there, which the seal would refuse
  readonly sweepRunDir: (paths: ImpPaths) => Promise<void>;

  // a destroyed imp's jail: released, then its directory removed
  readonly remove: (impId: string) => Promise<void>;

  // the jails of ids not in `impIds`, released and removed; returns the ids
  readonly removeOrphans: (impIds: ReadonlySet<string>) => Promise<string[]>;

  // run/ back to impd before any guest code runs, the VM's sockets bound.
  // Anything else there proves a compromised VM: it throws, deletes nothing
  // while the VM runs, and the caller kills it; the next prepare sweeps.
  readonly seal: (paths: ImpPaths, pid: number) => void;
}

// root in the container; the test's own uid in a unit test
const IMPD_USER = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

type CommandRunner = (argv: readonly string[]) => Promise<CommandResult>;

export interface JailDeps {
  readonly jailerBin: string;

  // an absolute path: the jailer copies it into each chroot
  readonly firecrackerBin: string;

  // <dataDir>/jail
  readonly chrootBase: string;
  readonly run: CommandRunner;

  // /proc/self/mounts by default
  readonly readMounts?: () => string;
  readonly log: (message: string) => void;

  // the imp's cgroup.kill (cpu-cgroups.ts), the pids a uid runs (a /proc
  // scan by default), and SIGKILL to one of them while it still runs as
  // the uid (through a pidfd by default)
  readonly killCgroup?: (impId: string) => void;
  readonly listUidPids?: (uid: number) => readonly number[];
  readonly killUidPid?: (pid: number, uid: number) => void;
}

const KILL_TRIES = 50;
const KILL_WAIT_MS = 20;

export function createJails(deps: Readonly<JailDeps>): Jails {
  const execName = basename(deps.firecrackerBin);
  const findJailDir = (impId: string): string => join(deps.chrootBase, execName, impId);
  const findRoot = (impId: string): string => join(findJailDir(impId), 'root');
  const readMounts = deps.readMounts ?? (() => readFileSync('/proc/self/mounts', 'utf8'));
  const listUidPids = deps.listUidPids ?? listProcessesOfUid;
  const killUidPid = deps.killUidPid ?? stopProcessOfUid;

  // Nothing of the jail's uid may outlive its Firecracker: root deletes,
  // unmounts and chowns in the jail next, and the uid goes to the next imp.
  const stopJailProcesses = async (impId: string, uid: number): Promise<void> => {
    if (uid === IMPD_USER.uid) {
      return;
    }

    deps.killCgroup?.(impId);

    for (let attempt = 1; attempt <= KILL_TRIES; attempt += 1) {
      const pids = listUidPids(uid);

      if (pids.length === 0) {
        return;
      }

      for (const pid of pids) {
        killUidPid(pid, uid);
      }

      await Bun.sleep(KILL_WAIT_MS);
    }

    throw new Error(`jail ${impId}: uid ${String(uid)} still runs processes`);
  };

  const runMount = async (argv: readonly string[]): Promise<void> => {
    const result = await deps.run(argv);

    if (result.exitCode !== 0) {
      throw new Error(`${argv.join(' ')}: ${result.stderr.trim()}`);
    }
  };

  // deepest first, so a bind inside another goes before it
  const removeMounts = async (impId: string): Promise<void> => {
    const owner = lstatSync(findRoot(impId), { throwIfNoEntry: false });

    if (owner !== undefined) {
      await stopJailProcesses(impId, owner.uid);
    }

    const mounted = listMountsUnder(readMounts(), findRoot(impId)).toReversed();

    for (const target of mounted) {
      const result = await deps.run(['umount', target]);

      if (result.exitCode !== 0) {
        await runMount(['umount', '--lazy', target]);
      }
    }
  };

  // never a recursive delete while anything is still mounted below
  const remove = async (impId: string): Promise<void> => {
    await removeMounts(impId);

    if (listMountsUnder(readMounts(), findRoot(impId)).length === 0) {
      rmSync(findJailDir(impId), { recursive: true, force: true });
    }
  };

  // `source` at `target` with every mount below it, each nosuid and nodev:
  // `=recursive` reaches the submounts (mount_setattr, util-linux 2.39+) and
  // keeps the rest of their flags, such as ro
  const setupDirBind = async (source: string, target: string): Promise<void> => {
    mkdirSync(target, { recursive: true });

    await runMount(['mount', '--rbind', '-o', 'nosuid=recursive,nodev=recursive', source, target]);
  };

  const setupReadOnlyBind = async (source: string, target: string): Promise<void> => {
    mkdirSync(dirname(target), { recursive: true });
    closeSync(openSync(target, 'a'));

    await runMount(['mount', '--bind', source, target]);
    await runMount(['mount', '-o', 'remount,bind,ro,nosuid,nodev', target]);
  };

  return {
    prepare: async (plan) => {
      const root = findRoot(plan.impId);

      await stopJailProcesses(plan.impId, plan.user.uid);
      await removeMounts(plan.impId);

      // never delete under a mount: that would reach the imp's own files
      if (listMountsUnder(readMounts(), root).length > 0) {
        throw new Error(`jail ${plan.impId}: ${root} still has mounts`);
      }

      setupOwnership(plan.paths, plan.user);

      // the last VM owned the chroot and may have left symlinks in it: a new
      // one each time, so no mkdir or mount below follows them
      rmSync(findJailDir(plan.impId), { recursive: true, force: true });
      mkdirSync(root, { recursive: true });

      // a mount of its own, private, so no bind below leaks out or in
      await runMount(['mount', '--bind', root, root]);
      await runMount(['mount', '--make-private', root]);

      for (const dir of listBoundDirs(plan.paths)) {
        await setupDirBind(dir, join(root, dir));
      }

      for (const file of plan.readOnlyFiles) {
        await setupReadOnlyBind(file, join(root, file));
      }

      await runMount(['mount', '--make-rprivate', root]);

      return buildJailerCommand({
        jailerBin: deps.jailerBin,
        firecrackerBin: deps.firecrackerBin,
        chrootBase: deps.chrootBase,
        impId: plan.impId,
        user: plan.user,
        apiSocket: plan.paths.apiSocket,
      });
    },
    release: removeMounts,
    sweepRunDir: async (paths) => {
      // first, so no process of the last jail's uid races the delete
      await removeMounts(paths.impId);

      setupImpdRunDir(paths);
    },
    remove,
    removeOrphans: async (impIds) => {
      const base = join(deps.chrootBase, execName);
      const ids = existsSync(base) ? readdirSync(base) : [];
      const orphans = ids.filter((impId) => !impIds.has(impId));
      const removed: string[] = [];

      for (const impId of orphans) {
        try {
          await remove(impId);

          removed.push(impId);
        } catch (error) {
          deps.log(`impd: jail ${impId}: ${readErrorMessage(error)}`);
        }
      }

      return removed;
    },
    seal: (paths, pid) => {
      // first, so nothing new lands in run/ while it is read
      setupImpdDir(paths.runDir);

      const planted = readdirSync(paths.runDir).filter(
        (name) => !isSealedEntry(paths, join(paths.runDir, name)),
      );

      if (planted.length > 0) {
        throw new Error(
          `jail ${paths.impId}: the VM left ${planted.join(', ')} in run/; a VM that writes there is compromised`,
        );
      }

      writeRegularFile(paths.pidFile, `${String(pid)}\n`);
    },
  };
}

interface JailerCommand {
  readonly jailerBin: string;
  readonly firecrackerBin: string;
  readonly chrootBase: string;
  readonly impId: string;
  readonly user: JailUser;
  readonly apiSocket: string;
}

// Execed in place, so the spawned pid is the VM's; no --cgroup, since
// cpu-cgroups.ts writes it; the API socket's path is what adoption matches.
export function buildJailerCommand(command: Readonly<JailerCommand>): readonly string[] {
  return [
    command.jailerBin,
    '--id',
    command.impId,
    '--exec-file',
    command.firecrackerBin,
    '--uid',
    String(command.user.uid),
    '--gid',
    String(command.user.gid),
    '--chroot-base-dir',
    command.chrootBase,
    '--',
    '--api-sock',
    command.apiSocket,
  ];
}

// the imp's directory, and the snapshot's when it lives elsewhere, as on ZFS
export function listBoundDirs(paths: Readonly<ImpPaths>): readonly string[] {
  const isInside = paths.snapshotDir.startsWith(`${paths.dir}/`);

  return isInside ? [paths.dir] : [paths.dir, paths.snapshotDir];
}

// The mount points at `root` or below it, shallowest first. /proc/self/mounts
// escapes a space as \040.
export function listMountsUnder(mounts: string, root: string): string[] {
  return mounts
    .split('\n')
    .map((line) => decodeMountPath(line.split(' ')[1] ?? ''))
    .filter((target) => target === root || target.startsWith(`${root}/`))
    .toSorted((a, b) => a.split('/').length - b.split('/').length);
}

function decodeMountPath(field: string): string {
  return field.replaceAll(/\\(?<octal>[0-7]{3})/g, (_match, octal: string) =>
    String.fromCodePoint(Number.parseInt(octal, 8)),
  );
}

// What the VM may write: run/ until it is sealed, the disk, and the snapshot
// files it loads. Directories stay impd's, so the VM can write into a file,
// never replace one with a symlink or a FIFO that impd then opens as root.
function setupOwnership(paths: Readonly<ImpPaths>, user: Readonly<JailUser>): void {
  // nothing the last VM left in run/ is there when the next one loads a snapshot
  setupImpdRunDir(paths);
  lchownSync(paths.runDir, user.uid, user.gid);
  setupImpdDir(paths.snapshotDir);

  for (const file of [paths.disk, paths.vmstate, paths.memFile]) {
    if (file !== paths.disk && !existsSync(file)) {
      continue;
    }

    if (!lstatSync(file).isFile()) {
      throw new Error(`${file} is not a regular file`);
    }
  }

  lchownSync(paths.disk, user.uid, user.gid);

  // the VM reads its snapshot, never writes it: impd's, readable by its group
  for (const file of [paths.vmstate, paths.memFile]) {
    if (existsSync(file)) {
      setupSnapshotFile(file, user.gid);
    }
  }
}

// run/ as impd's, with only the VM's sockets and impd's own files left in
// it: only once nothing of the jail's uid runs, since the delete recurses
function setupImpdRunDir(paths: Readonly<ImpPaths>): void {
  setupImpdDir(paths.runDir);

  for (const name of readdirSync(paths.runDir)) {
    const path = join(paths.runDir, name);

    if (!isSealedEntry(paths, path)) {
      rmSync(path, { recursive: true, force: true });
    }
  }
}

// The VM's two sockets, and the log and the pid file impd made: regular
// files of impd's with one name, not ones the VM made or linked to.
function isSealedEntry(paths: Readonly<ImpPaths>, path: string): boolean {
  const entry = lstatSync(path);

  if (path === paths.apiSocket || path === paths.vsockSocket) {
    return entry.isSocket();
  }

  return (
    (path === paths.logFile || path === paths.pidFile) &&
    entry.isFile() &&
    entry.uid === IMPD_USER.uid &&
    entry.nlink === 1
  );
}

// a directory of impd's own: a symlink or a file in its place goes first
function setupImpdDir(dir: string): void {
  setupRealDir(dir);
  lchownSync(dir, IMPD_USER.uid, IMPD_USER.gid);
  chmodSync(dir, 0o755);
}

// a snapshot file the VM wrote or reads: impd's, readable by the jail's group
export function setupSnapshotFile(file: string, gid: number): void {
  lchownSync(file, IMPD_USER.uid, gid);
  chmodSync(file, 0o640);
}

function setupRealDir(dir: string): void {
  const found = lstatSync(dir, { throwIfNoEntry: false });

  if (found !== undefined && !found.isDirectory()) {
    rmSync(dir, { force: true });
  }

  mkdirSync(dir, { recursive: true });
}

// every live process whose real or effective uid is `uid`
function listProcessesOfUid(uid: number): number[] {
  return readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .filter((pid) => isProcessOfUid(pid, uid));
}
