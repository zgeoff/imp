import { expect, onTestFinished, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildImpPaths } from '../storage/data-layout';
import { buildStubMounts } from '../test-utils/build-stub-mounts';
import { buildStubUidProcesses } from '../test-utils/build-stub-uid-processes';
import {
  buildJailerCommand,
  createJails,
  listBoundDirs,
  listMountsUnder,
  setupTemplateFile,
} from './jail';

function setupTest() {
  const dataDir = mkdtempSync(join(tmpdir(), 'imp-jail-'));

  onTestFinished(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const mounts = buildStubMounts();
  const processes = buildStubUidProcesses();
  const logs: string[] = [];

  // the mount commands and the kills in the order the jailer makes them
  const steps: string[] = [];

  const jails = createJails({
    jailerBin: 'jailer',
    firecrackerBin: '/usr/local/bin/firecracker',
    chrootBase: join(dataDir, 'jail'),
    run: (argv) => {
      steps.push(argv.join(' '));

      return mounts.run(argv);
    },
    readMounts: mounts.readMounts,
    log: (message) => {
      logs.push(message);
    },
    ...processes.deps,
    killCgroup: (impId) => {
      steps.push(`kill cgroup ${impId}`);
      processes.deps.killCgroup(impId);
    },
    killUidPid: (pid, uid) => {
      steps.push(`kill ${String(pid)}`);
      processes.deps.killUidPid(pid, uid);
    },

    // no real pause between two kill scans
    wait: () => Promise.resolve(),
  });

  const paths = buildImpPaths(dataDir, 'i1');

  // the imp's dir, which every jail binds
  mkdirSync(paths.dir, { recursive: true });

  return {
    dataDir,
    mounts,
    processes,
    logs,
    steps,
    jails,
    paths,

    // where the jailer chroots the imp i1
    root: join(dataDir, 'jail', 'firecracker', 'i1', 'root'),

    // the test's own uid, so the chowns work without root
    user: { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 },
  };
}

test('#buildJailerCommand execs Firecracker in place with the API socket at its own path', () => {
  const command = buildJailerCommand({
    jailerBin: 'jailer',
    firecrackerBin: '/usr/local/bin/firecracker',
    chrootBase: '/data/jail',
    impId: 'i1',
    user: { uid: 900_001, gid: 900_001 },
    apiSocket: '/data/imps/i1/run/api.sock',
  });

  expect(command).toStrictEqual([
    'jailer',
    '--id',
    'i1',
    '--exec-file',
    '/usr/local/bin/firecracker',
    '--uid',
    '900001',
    '--gid',
    '900001',
    '--chroot-base-dir',
    '/data/jail',
    '--',
    '--api-sock',
    '/data/imps/i1/run/api.sock',
  ]);
});

test('#listBoundDirs binds only the imp dir when the snapshot dir lives inside it', () => {
  expect(listBoundDirs(buildImpPaths('/data', 'i1'))).toStrictEqual(['/data/imps/i1']);
});

test('#listBoundDirs binds the snapshot dir too when it lives outside the imp dir', () => {
  const paths = { ...buildImpPaths('/data', 'i1'), snapshotDir: '/data/mem/i1' };

  expect(listBoundDirs(paths)).toStrictEqual(['/data/imps/i1', '/data/mem/i1']);
});

test('#listMountsUnder lists the mounts at or under a root, shallowest first, with escapes decoded', () => {
  const mounts = [
    '/dev/sda1 / ext4 rw 0 0',
    'src /j/root/data/imps/i1 ext4 rw 0 0',
    'src /j/root ext4 rw 0 0',
    String.raw`src /j/root/my\040dir ext4 rw 0 0`,
    'src /j/rootless ext4 rw 0 0',
  ].join('\n');

  expect(listMountsUnder(mounts, '/j/root')).toStrictEqual([
    '/j/root',
    '/j/root/my dir',
    '/j/root/data/imps/i1',
  ]);
});

test('#prepare binds the imp in at its own path, read-only files after, then makes the root rprivate', async () => {
  const ctx = setupTest();
  const kernel = join(ctx.dataDir, 'vmlinux');

  writeFileSync(kernel, '');
  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare({
    impId: 'i1',
    user: ctx.user,
    paths: ctx.paths,
    readOnlyFiles: [kernel],
  });

  expect(ctx.mounts.calls).toStrictEqual([
    `mount --bind ${ctx.root} ${ctx.root}`,
    `mount --make-private ${ctx.root}`,
    `mount --rbind -o nosuid=recursive,nodev=recursive ${ctx.paths.dir} ${ctx.root}${ctx.paths.dir}`,
    `mount --bind ${kernel} ${ctx.root}${kernel}`,
    `mount -o remount,bind,ro,nosuid,nodev ${ctx.root}${kernel}`,
    `mount --make-rprivate ${ctx.root}`,
  ]);
});

test('#prepare returns the jailer command for the imp', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, '');

  const command = await ctx.jails.prepare({
    impId: 'i1',
    user: ctx.user,
    paths: ctx.paths,
    readOnlyFiles: [],
  });

  expect(command).toStrictEqual([
    'jailer',
    '--id',
    'i1',
    '--exec-file',
    '/usr/local/bin/firecracker',
    '--uid',
    String(ctx.user.uid),
    '--gid',
    String(ctx.user.gid),
    '--chroot-base-dir',
    join(ctx.dataDir, 'jail'),
    '--',
    '--api-sock',
    ctx.paths.apiSocket,
  ]);
});

test('#prepare makes the run and snapshot dirs of the imp', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] });

  expect(lstatSync(ctx.paths.runDir).isDirectory()).toBeTrue();
  expect(lstatSync(ctx.paths.snapshotDir).isDirectory()).toBeTrue();
});

test('#prepare unmounts the binds of the last jail deepest first before it binds again', async () => {
  const ctx = setupTest();
  const plan = { impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] };

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare(plan);

  ctx.mounts.calls.length = 0;

  await ctx.jails.prepare(plan);

  expect(ctx.mounts.calls).toStrictEqual([
    `umount ${ctx.root}${ctx.paths.dir}`,
    `umount ${ctx.root}`,
    `mount --bind ${ctx.root} ${ctx.root}`,
    `mount --make-private ${ctx.root}`,
    `mount --rbind -o nosuid=recursive,nodev=recursive ${ctx.paths.dir} ${ctx.root}${ctx.paths.dir}`,
    `mount --make-rprivate ${ctx.root}`,
  ]);
});

test('#prepare removes what the last jailer made in the chroot', async () => {
  const ctx = setupTest();
  const plan = { impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] };

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare(plan);

  mkdirSync(join(ctx.root, 'dev', 'net'), { recursive: true });
  mkdirSync(join(ctx.root, 'firecracker'));
  writeFileSync(join(ctx.root, 'firecracker.pid'), '1');

  await ctx.jails.prepare(plan);

  expect(existsSync(join(ctx.root, 'dev'))).toBeFalse();
  expect(existsSync(join(ctx.root, 'firecracker'))).toBeFalse();
  expect(existsSync(join(ctx.root, 'firecracker.pid'))).toBeFalse();
});

test('#prepare rebuilds the chroot so a symlink the last VM planted leads nowhere', async () => {
  const ctx = setupTest();
  const plan = { impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] };
  const elsewhere = join(ctx.dataDir, 'elsewhere');

  // the first segment of the imp dir's absolute path, as it sits in the chroot
  const top = join(ctx.root, ctx.paths.dir.split('/')[1] ?? '');

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare(plan);
  await ctx.jails.release('i1');

  // the VM owned root/ and swapped the path to its bind for a symlink
  mkdirSync(elsewhere);
  rmSync(top, { recursive: true });
  symlinkSync(elsewhere, top);

  await ctx.jails.prepare(plan);

  expect(lstatSync(join(ctx.root, ctx.paths.dir)).isDirectory()).toBeTrue();
  expect(readdirSync(elsewhere)).toStrictEqual([]);
});

test('#prepare refuses a planted symlink as a snapshot file before any mount', () => {
  const ctx = setupTest();
  const outside = join(ctx.dataDir, 'outside');

  writeFileSync(ctx.paths.disk, '');
  writeFileSync(outside, '');
  mkdirSync(ctx.paths.snapshotDir, { recursive: true });
  writeFileSync(ctx.paths.memFile, '');
  symlinkSync(outside, ctx.paths.vmstate);

  expect(
    ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] }),
  ).rejects.toThrowWithMessage(Error, `${ctx.paths.vmstate} is not a regular file`);

  expect(ctx.mounts.mounted).toStrictEqual([]);
});

test('#prepare replaces a symlink in place of run/ with a directory', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, '');
  symlinkSync(ctx.dataDir, ctx.paths.runDir);

  await ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] });

  expect(lstatSync(ctx.paths.runDir).isDirectory()).toBeTrue();
});

test('#prepare keeps the snapshot dir readable by all and writable by impd only', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] });

  expect(lstatSync(ctx.paths.snapshotDir).mode & 0o777).toBe(0o755);
});

test('#prepare empties run/ and keeps the snapshot readable by the jail group before a wake', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, '');
  mkdirSync(ctx.paths.snapshotDir, { recursive: true });
  writeFileSync(ctx.paths.vmstate, 'vmstate');
  writeFileSync(ctx.paths.memFile, 'mem');

  // planted by the last VM, after its seal and before its kill
  mkdirSync(join(ctx.paths.runDir, 'planted'), { recursive: true });
  writeFileSync(join(ctx.paths.runDir, 'planted', 'payload'), 'x');
  writeFileSync(join(ctx.paths.runDir, 'api.sock'), 'not a socket');

  Bun.spawnSync(['mkfifo', join(ctx.paths.runDir, 'fifo')]);

  await ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] });

  expect(readdirSync(ctx.paths.runDir)).toStrictEqual([]);
  expect(lstatSync(ctx.paths.vmstate).mode & 0o777).toBe(0o640);
  expect(lstatSync(ctx.paths.memFile).mode & 0o777).toBe(0o640);
});

test('#prepare refuses a new jail while a mount stays after its umount', async () => {
  const ctx = setupTest();
  const plan = { impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] };

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare(plan);

  ctx.mounts.keepAfterUmount(ctx.root);

  expect(ctx.jails.prepare(plan)).rejects.toThrowWithMessage(
    Error,
    `jail i1: ${ctx.root} still has mounts`,
  );
});

test('#prepare fails with the stderr of a mount that fails', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, '');

  ctx.mounts.failMount(ctx.root, `mount: ${ctx.root}: permission denied.\n`);

  expect(
    ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] }),
  ).rejects.toThrowWithMessage(
    Error,
    `mount --bind ${ctx.root} ${ctx.root}: mount: ${ctx.root}: permission denied.`,
  );
});

test('#prepare kills the jail cgroup and each process of the jail uid before it touches a mount', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, '');

  ctx.processes.start(900_001, 4242);

  // a mount that never goes, so the prepare stops right after the kills
  ctx.mounts.addMount(ctx.root);
  ctx.mounts.refuseUmount(ctx.root);

  expect(
    ctx.jails.prepare({
      impId: 'i1',
      user: { uid: 900_001, gid: 900_001 },
      paths: ctx.paths,
      readOnlyFiles: [],
    }),
  ).rejects.toThrowWithMessage(
    Error,
    `umount --lazy ${ctx.root}: umount: ${ctx.root}: target is busy.`,
  );

  expect(ctx.steps).toStrictEqual([
    'kill cgroup i1',
    'kill 4242',
    `umount ${ctx.root}`,
    `umount --lazy ${ctx.root}`,
  ]);
});

test('#prepare refuses a start while a process of the jail uid survives the kills', () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, '');

  ctx.processes.start(900_001, 4242);
  ctx.processes.surviveKills(4242);

  expect(
    ctx.jails.prepare({
      impId: 'i1',
      user: { uid: 900_001, gid: 900_001 },
      paths: ctx.paths,
      readOnlyFiles: [],
    }),
  ).rejects.toThrowWithMessage(Error, 'jail i1: uid 900001 still runs processes');

  expect(ctx.mounts.mounted).toStrictEqual([]);
});

test('#prepare refuses a scratch file inside a bound dir, where it would land in the real one', () => {
  const ctx = setupTest();
  const scratch = join(ctx.paths.dir, 'placeholder.ext4');

  writeFileSync(ctx.paths.disk, '');

  expect(
    ctx.jails.prepare({
      impId: 'i1',
      user: ctx.user,
      paths: ctx.paths,
      readOnlyFiles: [],
      scratchFiles: [scratch],
    }),
  ).rejects.toThrowWithMessage(Error, `jail i1: ${scratch} is inside a bound directory`);

  expect(existsSync(scratch)).toBeFalse();
});

test('#prepare makes a restore jail before its disk exists', async () => {
  const ctx = setupTest();

  await expect(
    ctx.jails.prepare({
      impId: 'i1',
      user: ctx.user,
      paths: ctx.paths,
      readOnlyFiles: [],
      isDiskLate: true,
    }),
  ).toResolve();
});

test('#setupDiskOwner refuses a disk the clone left as a symlink', async () => {
  const ctx = setupTest();
  const outside = join(ctx.dataDir, 'outside');

  await ctx.jails.prepare({
    impId: 'i1',
    user: ctx.user,
    paths: ctx.paths,
    readOnlyFiles: [],
    isDiskLate: true,
  });

  writeFileSync(outside, '');
  symlinkSync(outside, ctx.paths.disk);

  expect(() => {
    ctx.jails.setupDiskOwner(ctx.paths, ctx.user);
  }).toThrowWithMessage(Error, `${ctx.paths.disk} is not a regular file`);
});

test('#setupDiskOwner hands a regular disk to the jail user', async () => {
  const ctx = setupTest();

  await ctx.jails.prepare({
    impId: 'i1',
    user: ctx.user,
    paths: ctx.paths,
    readOnlyFiles: [],
    isDiskLate: true,
  });

  writeFileSync(ctx.paths.disk, '');

  ctx.jails.setupDiskOwner(ctx.paths, ctx.user);

  expect(lstatSync(ctx.paths.disk).uid).toBe(ctx.user.uid);
});

test('#prepareBuild binds the work dir and the read-only files of a template build', async () => {
  const ctx = setupTest();
  const work = join(ctx.dataDir, 'templates', '.build-1');
  const runDir = join(work, 'run');
  const kernel = join(ctx.dataDir, 'vmlinux');
  const buildRoot = join(ctx.dataDir, 'jail', 'firecracker', 'tpl-build', 'root');

  mkdirSync(runDir, { recursive: true });
  writeFileSync(kernel, '');

  await ctx.jails.prepareBuild({
    id: 'tpl-build',
    user: ctx.user,
    workDir: work,
    paths: {
      runDir,
      apiSocket: join(runDir, 'api.sock'),
      vsockSocket: join(runDir, 'vsock.sock'),
      logFile: join(runDir, 'firecracker.log'),
      pidFile: join(runDir, 'pid'),
    },
    readOnlyFiles: [kernel],
    scratchFiles: [],
  });

  expect(ctx.mounts.calls).toStrictEqual([
    `mount --bind ${buildRoot} ${buildRoot}`,
    `mount --make-private ${buildRoot}`,
    `mount --rbind -o nosuid=recursive,nodev=recursive ${work} ${buildRoot}${work}`,
    `mount --bind ${kernel} ${buildRoot}${kernel}`,
    `mount -o remount,bind,ro,nosuid,nodev ${buildRoot}${kernel}`,
    `mount --make-rprivate ${buildRoot}`,
  ]);
});

test('#prepareBuild gives the build a placeholder of its own in the chroot and leaves the shared one untouched', async () => {
  const ctx = setupTest();
  const work = join(ctx.dataDir, 'templates', '.build-1');
  const runDir = join(work, 'run');
  const placeholder = join(ctx.dataDir, 'templates', 'placeholder.ext4');
  const buildRoot = join(ctx.dataDir, 'jail', 'firecracker', 'tpl-build', 'root');

  mkdirSync(runDir, { recursive: true });
  writeFileSync(placeholder, 'shared');
  truncateSync(placeholder, 1024 * 1024);

  await ctx.jails.prepareBuild({
    id: 'tpl-build',
    user: ctx.user,
    workDir: work,
    paths: {
      runDir,
      apiSocket: join(runDir, 'api.sock'),
      vsockSocket: join(runDir, 'vsock.sock'),
      logFile: join(runDir, 'firecracker.log'),
      pidFile: join(runDir, 'pid'),
    },
    readOnlyFiles: [],
    scratchFiles: [placeholder],
  });

  expect(lstatSync(join(buildRoot, placeholder)).size).toBe(1024 * 1024);
  expect(readFileSync(join(buildRoot, placeholder), 'utf8')).not.toStartWith('shared');
  expect(readFileSync(placeholder, 'utf8')).toStartWith('shared');
  expect(ctx.mounts.calls).toSatisfyAll((call: string) => !call.includes('placeholder'));
});

test('#release detaches a busy mount lazily', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] });

  ctx.mounts.refusePlainUmount(ctx.root);

  ctx.mounts.calls.length = 0;

  await ctx.jails.release('i1');

  expect(ctx.mounts.calls).toStrictEqual([
    `umount ${ctx.root}${ctx.paths.dir}`,
    `umount ${ctx.root}`,
    `umount --lazy ${ctx.root}`,
  ]);

  expect(ctx.mounts.mounted).toStrictEqual([]);
});

test('#release fails with the stderr of a lazy umount that fails too', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] });

  ctx.mounts.refuseUmount(ctx.root);

  expect(ctx.jails.release('i1')).rejects.toThrowWithMessage(
    Error,
    `umount --lazy ${ctx.root}: umount: ${ctx.root}: target is busy.`,
  );
});

test('#remove unmounts a jail and deletes its dir', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] });
  await ctx.jails.remove('i1');

  expect(ctx.mounts.mounted).toStrictEqual([]);
  expect(existsSync(join(ctx.dataDir, 'jail', 'firecracker', 'i1'))).toBeFalse();
});

test('#remove never deletes a jail that still has mounts', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] });

  ctx.mounts.keepAfterUmount(ctx.root);

  await ctx.jails.remove('i1');

  expect(existsSync(ctx.root)).toBeTrue();
});

test('#removeOrphans removes the jails of ids it is not given and returns those ids', async () => {
  const ctx = setupTest();
  const plan = { impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] };

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare(plan);
  await ctx.jails.prepare({ ...plan, impId: 'i2' });

  const removed = await ctx.jails.removeOrphans(new Set(['i2']));

  expect(removed).toStrictEqual(['i1']);
  expect(existsSync(join(ctx.dataDir, 'jail', 'firecracker', 'i1'))).toBeFalse();
  expect(existsSync(join(ctx.dataDir, 'jail', 'firecracker', 'i2'))).toBeTrue();
});

test('#removeOrphans never touches the files of the imp an orphan jail bound', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, 'disk');

  await ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] });
  await ctx.jails.removeOrphans(new Set());

  expect(readFileSync(ctx.paths.disk, 'utf8')).toBe('disk');
});

test('#removeOrphans logs and keeps an orphan jail that will not unmount, and removes the rest', async () => {
  const ctx = setupTest();
  const plan = { impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] };
  const deepest = `${ctx.root}${ctx.paths.dir}`;

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare(plan);
  await ctx.jails.prepare({ ...plan, impId: 'i2' });

  ctx.mounts.refuseUmount(deepest);

  const removed = await ctx.jails.removeOrphans(new Set());

  expect(removed).toStrictEqual(['i2']);

  expect(ctx.logs).toStrictEqual([
    `impd: jail i1: umount --lazy ${deepest}: umount: ${deepest}: target is busy.`,
  ]);

  expect(existsSync(ctx.root)).toBeTrue();
});

test('#seal hands run/ back to impd with its log and a new pid file', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] });

  chmodSync(ctx.paths.runDir, 0o700);

  // what a start leaves: impd's log and pid file
  writeFileSync(ctx.paths.logFile, 'boot\n');
  writeFileSync(ctx.paths.pidFile, '1\n');

  ctx.jails.seal(ctx.paths, 4242);

  expect(lstatSync(ctx.paths.runDir).mode & 0o777).toBe(0o755);
  expect(readdirSync(ctx.paths.runDir).toSorted()).toStrictEqual(['firecracker.log', 'pid']);
  expect(readFileSync(ctx.paths.pidFile, 'utf8')).toBe('4242\n');
});

test('#seal refuses a dir the VM left in run/ and deletes nothing', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] });

  writeFileSync(ctx.paths.logFile, 'boot\n');
  writeFileSync(ctx.paths.pidFile, '1\n');
  mkdirSync(join(ctx.paths.runDir, 'planted', 'deep'), { recursive: true });

  expect(() => {
    ctx.jails.seal(ctx.paths, 4242);
  }).toThrowWithMessage(
    Error,
    `${ctx.paths.runDir}: the VM left planted there; a VM that writes there is compromised`,
  );

  expect(readdirSync(ctx.paths.runDir).toSorted()).toStrictEqual([
    'firecracker.log',
    'pid',
    'planted',
  ]);

  expect(readFileSync(ctx.paths.pidFile, 'utf8')).toBe('1\n');
});

test('#seal leaves run/ readable by all when it refuses what the VM left there', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] });

  chmodSync(ctx.paths.runDir, 0o700);
  writeFileSync(ctx.paths.logFile, 'boot\n');
  writeFileSync(ctx.paths.pidFile, '1\n');
  mkdirSync(join(ctx.paths.runDir, 'planted'));

  expect(() => {
    ctx.jails.seal(ctx.paths, 4242);
  }).toThrowWithMessage(
    Error,
    `${ctx.paths.runDir}: the VM left planted there; a VM that writes there is compromised`,
  );

  expect(lstatSync(ctx.paths.runDir).mode & 0o777).toBe(0o755);
});

test('#seal refuses a FIFO the VM left in run/ and deletes nothing', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] });

  writeFileSync(ctx.paths.logFile, 'boot\n');
  writeFileSync(ctx.paths.pidFile, '1\n');

  Bun.spawnSync(['mkfifo', join(ctx.paths.runDir, 'fifo')]);

  expect(() => {
    ctx.jails.seal(ctx.paths, 4242);
  }).toThrowWithMessage(
    Error,
    `${ctx.paths.runDir}: the VM left fifo there; a VM that writes there is compromised`,
  );

  expect(readdirSync(ctx.paths.runDir).toSorted()).toStrictEqual([
    'fifo',
    'firecracker.log',
    'pid',
  ]);

  expect(readFileSync(ctx.paths.pidFile, 'utf8')).toBe('1\n');
});

test('#seal refuses a second link to the log in run/ and deletes nothing', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] });

  writeFileSync(ctx.paths.logFile, 'boot\n');
  writeFileSync(ctx.paths.pidFile, '1\n');
  linkSync(ctx.paths.logFile, join(ctx.paths.runDir, 'log-link'));

  expect(() => {
    ctx.jails.seal(ctx.paths, 4242);
  }).toThrowWithMessage(
    Error,
    /: the VM left .*log-link.* there; a VM that writes there is compromised$/,
  );

  expect(readdirSync(ctx.paths.runDir).toSorted()).toStrictEqual([
    'firecracker.log',
    'log-link',
    'pid',
  ]);

  expect(readFileSync(ctx.paths.pidFile, 'utf8')).toBe('1\n');
});

test('#seal refuses a symlink as the pid file and leaves it unwritten', async () => {
  const ctx = setupTest();
  const outside = join(ctx.dataDir, 'outside');

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] });

  writeFileSync(ctx.paths.logFile, 'boot\n');
  writeFileSync(outside, 'untouched');
  symlinkSync(outside, ctx.paths.pidFile);

  expect(() => {
    ctx.jails.seal(ctx.paths, 4242);
  }).toThrowWithMessage(
    Error,
    `${ctx.paths.runDir}: the VM left pid there; a VM that writes there is compromised`,
  );

  expect(lstatSync(ctx.paths.pidFile).isSymbolicLink()).toBeTrue();
  expect(readFileSync(outside, 'utf8')).toBe('untouched');
});

test('#prepare sweeps a dir the last VM left in run/', async () => {
  const ctx = setupTest();
  const plan = { impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] };

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare(plan);

  writeFileSync(ctx.paths.logFile, 'boot\n');
  writeFileSync(ctx.paths.pidFile, '1\n');
  mkdirSync(join(ctx.paths.runDir, 'planted', 'deep'), { recursive: true });

  await ctx.jails.release('i1');
  await ctx.jails.prepare(plan);

  expect(readdirSync(ctx.paths.runDir).toSorted()).toStrictEqual(['firecracker.log', 'pid']);
});

test('#prepare sweeps a FIFO the last VM left in run/', async () => {
  const ctx = setupTest();
  const plan = { impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] };

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare(plan);

  writeFileSync(ctx.paths.logFile, 'boot\n');
  writeFileSync(ctx.paths.pidFile, '1\n');

  Bun.spawnSync(['mkfifo', join(ctx.paths.runDir, 'fifo')]);

  await ctx.jails.release('i1');
  await ctx.jails.prepare(plan);

  expect(readdirSync(ctx.paths.runDir).toSorted()).toStrictEqual(['firecracker.log', 'pid']);
});

test('#prepare sweeps a second link to the log out of run/', async () => {
  const ctx = setupTest();
  const plan = { impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] };

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare(plan);

  writeFileSync(ctx.paths.logFile, 'boot\n');
  writeFileSync(ctx.paths.pidFile, '1\n');
  linkSync(ctx.paths.logFile, join(ctx.paths.runDir, 'log-link'));

  await ctx.jails.release('i1');
  await ctx.jails.prepare(plan);

  expect(readdirSync(ctx.paths.runDir)).not.toContain('log-link');
  expect(readdirSync(ctx.paths.runDir)).toContain('pid');
});

test('#prepare keeps only regular files in run/ after it sweeps what the last VM left', async () => {
  const ctx = setupTest();
  const plan = { impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] };

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare(plan);

  writeFileSync(ctx.paths.logFile, 'boot\n');
  writeFileSync(ctx.paths.pidFile, '1\n');
  mkdirSync(join(ctx.paths.runDir, 'planted'));
  symlinkSync('/etc/hostname', join(ctx.paths.runDir, 'link'));

  const mkfifo = Bun.spawnSync(['mkfifo', join(ctx.paths.runDir, 'fifo')]);

  expect(mkfifo.exitCode).toBe(0);

  await ctx.jails.release('i1');
  await ctx.jails.prepare(plan);

  expect(
    readdirSync(ctx.paths.runDir).filter(
      (name) => !lstatSync(join(ctx.paths.runDir, name)).isFile(),
    ),
  ).toStrictEqual([]);
});

test('#prepare sweeps a symlink the last VM left as the pid file', async () => {
  const ctx = setupTest();
  const plan = { impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] };
  const outside = join(ctx.dataDir, 'outside');

  writeFileSync(ctx.paths.disk, '');

  await ctx.jails.prepare(plan);

  writeFileSync(ctx.paths.logFile, 'boot\n');
  writeFileSync(outside, 'untouched');
  symlinkSync(outside, ctx.paths.pidFile);

  await ctx.jails.release('i1');
  await ctx.jails.prepare(plan);

  expect(readdirSync(ctx.paths.runDir)).toStrictEqual(['firecracker.log']);
  expect(readFileSync(outside, 'utf8')).toBe('untouched');
});

test('#sweepRunDir unmounts the jail and empties run/ of what a jailed VM planted', async () => {
  const ctx = setupTest();
  const outside = join(ctx.dataDir, 'outside');

  writeFileSync(ctx.paths.disk, '');
  writeFileSync(outside, '');

  await ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] });

  mkdirSync(join(ctx.paths.runDir, 'planted', 'deep'), { recursive: true });
  symlinkSync(outside, ctx.paths.pidFile);

  await ctx.jails.sweepRunDir(ctx.paths);

  expect(ctx.mounts.mounted).toStrictEqual([]);
  expect(readdirSync(ctx.paths.runDir)).toStrictEqual([]);
});

test('#seal passes for an unjailed start after a sweep of what a jailed VM planted', async () => {
  const ctx = setupTest();
  const outside = join(ctx.dataDir, 'outside');

  writeFileSync(ctx.paths.disk, '');
  writeFileSync(outside, '');

  await ctx.jails.prepare({ impId: 'i1', user: ctx.user, paths: ctx.paths, readOnlyFiles: [] });

  // the jailed VM's leftovers, then a switch to IMP_JAILER=false
  mkdirSync(join(ctx.paths.runDir, 'planted', 'deep'), { recursive: true });
  symlinkSync(outside, ctx.paths.pidFile);

  await ctx.jails.sweepRunDir(ctx.paths);

  // what an unjailed start leaves before its seal
  writeFileSync(ctx.paths.logFile, 'boot\n');

  ctx.jails.seal(ctx.paths, 4242);

  expect(readdirSync(ctx.paths.runDir).toSorted()).toStrictEqual(['firecracker.log', 'pid']);
});

test('#setupTemplateFile refuses a template file with a second name', () => {
  const ctx = setupTest();
  const mem = join(ctx.dataDir, 'mem');

  writeFileSync(mem, 'm');
  linkSync(mem, join(ctx.dataDir, 'kept'));

  expect(() => {
    setupTemplateFile(mem);
  }).toThrowWithMessage(Error, `${mem} is not a regular file with one name`);
});

test('#setupTemplateFile makes a template file readable by all', () => {
  const ctx = setupTest();
  const mem = join(ctx.dataDir, 'mem');

  writeFileSync(mem, 'm');
  chmodSync(mem, 0o600);
  setupTemplateFile(mem);

  expect(lstatSync(mem).mode & 0o777).toBe(0o644);
});
