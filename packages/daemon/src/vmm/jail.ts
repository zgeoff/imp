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
  statSync,
  truncateSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { CommandResult } from '../process/run-command';
import { readErrorMessage } from '../read-error-message';
import type { ImpPaths } from '../storage/data-layout';
import type { FirecrackerPaths } from './firecracker-process';
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

  // files the VM opens read-write, each a copy of its size of its own in the
  // chroot: the template's placeholder disk on a restore
  readonly scratchFiles?: readonly string[];

  // a restore starts before its disk is sized: setupDiskOwner once it is ready
  readonly isDiskLate?: boolean;
}

// A template build's jail (docs/architecture/boot-templates.md#make): its
// work dir bound in, run/ the VM's until the seal.
interface BuildJailPlan {
  readonly id: string;
  readonly user: JailUser;
  readonly workDir: string;
  readonly paths: RunPaths;
  readonly readOnlyFiles: readonly string[];
  readonly scratchFiles: readonly string[];
}

// the sockets, the log and the pid file of one VM, in its run/
export interface RunPaths extends FirecrackerPaths {
  readonly runDir: string;
}

export interface Jails {
  // a clean chroot with its binds; the command that starts Firecracker in it
  readonly prepare: (plan: Readonly<JailPlan>) => Promise<readonly string[]>;
  readonly prepareBuild: (plan: Readonly<BuildJailPlan>) => Promise<readonly string[]>;

  // the disk of a restore, once cloned: a regular file, the jail uid's
  readonly setupDiskOwner: (paths: ImpPaths, user: Readonly<JailUser>) => void;

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
  readonly seal: (paths: RunPaths, pid: number) => void;
}

// what setupChroot builds: the jail's id, its binds and its VM's files
interface ChrootPlan {
  readonly id: string;
  readonly user: JailUser;
  readonly dirs: readonly string[];
  readonly readOnlyFiles: readonly string[];
  readonly scratchFiles: readonly string[];
  readonly apiSocket: string;
  readonly setupFiles: () => void;
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

  // the pause between two kill scans; Bun.sleep by default
  readonly wait?: (ms: number) => Promise<void>;
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
  const wait = deps.wait ?? Bun.sleep;

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

      await wait(KILL_WAIT_MS);
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

  // No process of the uid, no mount left, then a new chroot with its binds.
  // `setupFiles` runs between: root works on the VM's files then.
  const setupChroot = async (chroot: Readonly<ChrootPlan>): Promise<readonly string[]> => {
    const root = findRoot(chroot.id);

    await stopJailProcesses(chroot.id, chroot.user.uid);
    await removeMounts(chroot.id);

    // never delete under a mount: that would reach the imp's own files
    if (listMountsUnder(readMounts(), root).length > 0) {
      throw new Error(`jail ${chroot.id}: ${root} still has mounts`);
    }

    chroot.setupFiles();

    // the last VM owned the chroot and may have left symlinks in it: a new
    // one each time, so no mkdir or mount below follows them
    rmSync(findJailDir(chroot.id), { recursive: true, force: true });
    mkdirSync(root, { recursive: true });

    // a mount of its own, private, so no bind below leaks out or in
    await runMount(['mount', '--bind', root, root]);
    await runMount(['mount', '--make-private', root]);

    for (const dir of chroot.dirs) {
      await setupDirBind(dir, join(root, dir));
    }

    for (const file of chroot.readOnlyFiles) {
      await setupReadOnlyBind(file, join(root, file));
    }

    for (const file of chroot.scratchFiles) {
      if (chroot.dirs.some((dir) => file.startsWith(`${dir}/`))) {
        throw new Error(`jail ${chroot.id}: ${file} is inside a bound directory`);
      }

      setupScratchFile(file, join(root, file), chroot.user);
    }

    await runMount(['mount', '--make-rprivate', root]);

    return buildJailerCommand({
      jailerBin: deps.jailerBin,
      firecrackerBin: deps.firecrackerBin,
      chrootBase: deps.chrootBase,
      impId: chroot.id,
      user: chroot.user,
      apiSocket: chroot.apiSocket,
    });
  };

  return {
    prepare: (plan) =>
      setupChroot({
        id: plan.impId,
        user: plan.user,
        dirs: listBoundDirs(plan.paths),
        readOnlyFiles: plan.readOnlyFiles,
        scratchFiles: plan.scratchFiles ?? [],
        apiSocket: plan.paths.apiSocket,
        setupFiles: () => {
          setupOwnership(plan.paths, plan.user, plan.isDiskLate ?? false);
        },
      }),
    prepareBuild: (plan) =>
      setupChroot({
        id: plan.id,
        user: plan.user,
        dirs: [plan.workDir],
        readOnlyFiles: plan.readOnlyFiles,
        scratchFiles: plan.scratchFiles,
        apiSocket: plan.paths.apiSocket,
        setupFiles: () => {
          setupImpdRunDir(plan.paths);
          lchownSync(plan.paths.runDir, plan.user.uid, plan.user.gid);
        },
      }),
    setupDiskOwner: (paths, user) => {
      requireRegularFile(paths.disk);
      lchownSync(paths.disk, user.uid, user.gid);
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
          `${paths.runDir}: the VM left ${planted.join(', ')} there; a VM that writes there is compromised`,
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
function setupOwnership(
  paths: Readonly<ImpPaths>,
  user: Readonly<JailUser>,
  isDiskLate: boolean,
): void {
  // nothing the last VM left in run/ is there when the next one loads a snapshot
  setupImpdRunDir(paths);
  lchownSync(paths.runDir, user.uid, user.gid);
  setupImpdDir(paths.snapshotDir);

  for (const file of [paths.vmstate, paths.memFile]) {
    if (existsSync(file)) {
      requireRegularFile(file);
    }
  }

  if (!isDiskLate) {
    requireRegularFile(paths.disk);
    lchownSync(paths.disk, user.uid, user.gid);
  }

  // the VM reads its snapshot, never writes it: impd's, readable by its group
  for (const file of [paths.vmstate, paths.memFile]) {
    if (existsSync(file)) {
      setupSnapshotFile(file, user.gid);
    }
  }
}

// A file of the jail uid's own inside the chroot only, never on the host
// path: a placeholder disk the VM opens read-write, as large as the host's
// one, which the snapshot recorded.
function setupScratchFile(source: string, target: string, user: Readonly<JailUser>): void {
  mkdirSync(dirname(target), { recursive: true });
  closeSync(openSync(target, 'wx', 0o600));
  truncateSync(target, statSync(source).size);
  lchownSync(target, user.uid, user.gid);
}

function requireRegularFile(file: string): void {
  if (!lstatSync(file).isFile()) {
    throw new Error(`${file} is not a regular file`);
  }
}

// run/ as impd's, with only the VM's sockets and impd's own files left in
// it: only once nothing of the jail's uid runs, since the delete recurses
function setupImpdRunDir(paths: Readonly<RunPaths>): void {
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
function isSealedEntry(paths: Readonly<RunPaths>, path: string): boolean {
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

// A template's file, once the build's uid is gone: the regular file it wrote,
// with one name, then root's and readable by every jail that restores it.
export function setupTemplateFile(file: string): void {
  const entry = lstatSync(file);

  if (!entry.isFile() || entry.nlink !== 1) {
    throw new Error(`${file} is not a regular file with one name`);
  }

  lchownSync(file, IMPD_USER.uid, IMPD_USER.gid);
  chmodSync(file, 0o644);
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
