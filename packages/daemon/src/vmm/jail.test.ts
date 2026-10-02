import { expect, test } from 'bun:test';
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult } from '../process/run-command';
import { readErrorMessage } from '../read-error-message';
import { readRejection } from '../read-rejection';
import { buildImpPaths } from '../storage/data-layout';
import type { ImpPaths } from '../storage/data-layout';
import { buildJailerCommand, createJails, listBoundDirs, listMountsUnder } from './jail';
import type { JailDeps } from './jail';

// the test's own uid, so the chowns work without root
const USER = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

// a data dir in a temp dir, and a fake `mount` that keeps a mount table;
// `busy` targets refuse a plain umount, as a mount in use does
function setupJails(
  isBusyTarget: (target: string) => boolean = () => false,
  isStuckTarget: (target: string) => boolean = () => false,
  processes: Pick<JailDeps, 'killCgroup' | 'listUidPids' | 'killUidPid'> = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'imp-jail-'));
  const chrootBase = join(dataDir, 'jail');
  const calls: string[] = [];
  const mounted: string[] = [];
  const logs: string[] = [];

  const run = (argv: readonly string[]): Promise<CommandResult> => {
    calls.push(argv.join(' '));

    const target = argv.at(-1) ?? '';
    const isUmount = argv[0] === 'umount';

    const isBusy =
      isUmount && ((argv[1] !== '--lazy' && isBusyTarget(target)) || isStuckTarget(target));

    if (isUmount && !isBusy && mounted.includes(target)) {
      mounted.splice(mounted.indexOf(target), 1);
    }

    if (argv[0] === 'mount' && (argv[1] === '--bind' || argv[1] === '--rbind')) {
      mounted.push(target);
    }

    return Promise.resolve({ exitCode: isBusy ? 32 : 0, stdout: '', stderr: '' });
  };

  const jails = createJails({
    jailerBin: 'jailer',
    firecrackerBin: '/usr/local/bin/firecracker',
    chrootBase,
    run,
    readMounts: () => mounted.map((target) => `src ${target} ext4 rw 0 0`).join('\n'),
    log: (message) => {
      logs.push(message);
    },
    listUidPids: () => [],
    ...processes,
  });

  const paths = buildImpPaths(dataDir, 'i1');
  const root = join(chrootBase, 'firecracker', 'i1', 'root');

  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.disk, '');

  return { calls, mounted, jails, paths, root, dataDir, logs };
}

test('the jailer execs Firecracker in place, with the API socket at its own path', () => {
  const command = buildJailerCommand({
    jailerBin: 'jailer',
    firecrackerBin: '/usr/local/bin/firecracker',
    chrootBase: '/data/jail',
    impId: 'i1',
    user: { uid: 900_001, gid: 900_001 },
    apiSocket: '/data/imps/i1/run/api.sock',
  });

  expect(command.join(' ')).toBe(
    'jailer --id i1 --exec-file /usr/local/bin/firecracker --uid 900001 --gid 900001' +
      ' --chroot-base-dir /data/jail -- --api-sock /data/imps/i1/run/api.sock',
  );

  expect(command).not.toContain('--daemonize');
  expect(command).not.toContain('--cgroup');
});

test('it binds the snapshot dir only when it lives outside the imp dir', () => {
  const paths = buildImpPaths('/data', 'i1');

  expect(listBoundDirs(paths)).toEqual(['/data/imps/i1']);

  const zfs: ImpPaths = { ...paths, snapshotDir: '/data/mem/i1' };

  expect(listBoundDirs(zfs)).toEqual(['/data/imps/i1', '/data/mem/i1']);
});

test('it lists the mounts at or under a root, shallowest first, with escapes decoded', () => {
  const mounts = [
    '/dev/sda1 / ext4 rw 0 0',
    'src /j/root/data/imps/i1 ext4 rw 0 0',
    'src /j/root ext4 rw 0 0',
    String.raw`src /j/root/my\040dir ext4 rw 0 0`,
    'src /j/rootless ext4 rw 0 0',
  ].join('\n');

  expect(listMountsUnder(mounts, '/j/root')).toEqual([
    '/j/root',
    '/j/root/my dir',
    '/j/root/data/imps/i1',
  ]);
});

test('prepare binds the imp in at its own path, read-only files after, then rprivate', async () => {
  const jail = setupJails();
  const kernel = join(jail.dataDir, 'vmlinux');

  writeFileSync(kernel, '');

  const command = await jail.jails.prepare({
    impId: 'i1',
    user: USER,
    paths: jail.paths,
    readOnlyFiles: [kernel],
  });

  expect(jail.calls).toEqual([
    `mount --bind ${jail.root} ${jail.root}`,
    `mount --make-private ${jail.root}`,
    `mount --rbind -o nosuid=recursive,nodev=recursive ${jail.paths.dir} ${jail.root}${jail.paths.dir}`,
    `mount --bind ${kernel} ${jail.root}${kernel}`,
    `mount -o remount,bind,ro,nosuid,nodev ${jail.root}${kernel}`,
    `mount --make-rprivate ${jail.root}`,
  ]);

  expect(command[0]).toBe('jailer');
  expect(existsSync(jail.paths.runDir)).toBe(true);
  expect(existsSync(jail.paths.snapshotDir)).toBe(true);
});

test('prepare clears what the last jailer made, and releases old mounts first', async () => {
  const jail = setupJails();
  const plan = { impId: 'i1', user: USER, paths: jail.paths, readOnlyFiles: [] };

  await jail.jails.prepare(plan);

  for (const made of ['dev/net', 'firecracker']) {
    mkdirSync(join(jail.root, made), { recursive: true });
  }

  writeFileSync(join(jail.root, 'firecracker.pid'), '1');

  jail.calls.length = 0;

  await jail.jails.prepare(plan);

  expect(jail.calls.slice(0, 2)).toEqual([
    `umount ${jail.root}${jail.paths.dir}`,
    `umount ${jail.root}`,
  ]);

  expect(existsSync(join(jail.root, 'dev'))).toBe(false);
  expect(existsSync(join(jail.root, 'firecracker'))).toBe(false);
  expect(existsSync(join(jail.root, 'firecracker.pid'))).toBe(false);
});

test('a busy mount is detached lazily; one that stays refuses a new jail', async () => {
  const busy = setupJails((target) => target.endsWith('/root'));
  const plan = { impId: 'i1', user: USER, paths: busy.paths, readOnlyFiles: [] };

  await busy.jails.prepare(plan);
  await busy.jails.release('i1');

  expect(busy.calls).toContain(`umount --lazy ${busy.root}`);
  expect(busy.mounted).toEqual([]);

  // a fake that never unmounts: the binds stay, so nothing below is touched
  const stuck = setupJails();

  await stuck.jails.prepare({ ...plan, paths: stuck.paths });

  stuck.mounted.push(stuck.root);

  const leftover = createJails({
    jailerBin: 'jailer',
    firecrackerBin: '/usr/local/bin/firecracker',
    chrootBase: join(stuck.dataDir, 'jail'),
    run: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    readMounts: () => stuck.mounted.map((target) => `src ${target} ext4 rw 0 0`).join('\n'),
    log: () => {},
  });

  const error = await readRejection(leftover.prepare({ ...plan, paths: stuck.paths }));

  expect(readErrorMessage(error)).toContain('still has mounts');

  await leftover.remove('i1');

  expect(existsSync(stuck.root)).toBe(true);
});

test('remove deletes a jail once its mounts are gone; orphans go too', async () => {
  const jail = setupJails();
  const plan = { impId: 'i1', user: USER, paths: jail.paths, readOnlyFiles: [] };

  await jail.jails.prepare(plan);
  await jail.jails.prepare({ ...plan, impId: 'i2' });

  const orphans = await jail.jails.removeOrphans(new Set(['i2']));

  expect(orphans).toEqual(['i1']);
  expect(existsSync(jail.root)).toBe(false);
  expect(existsSync(jail.paths.dir)).toBe(true);
  expect(existsSync(jail.paths.disk)).toBe(true);

  await jail.jails.remove('i2');

  expect(jail.mounted).toEqual([]);
});

test('prepare rebuilds the chroot, so a symlink the last VM planted leads nowhere', async () => {
  const jail = setupJails();
  const plan = { impId: 'i1', user: USER, paths: jail.paths, readOnlyFiles: [] };
  const elsewhere = join(jail.dataDir, 'elsewhere');

  await jail.jails.prepare(plan);
  await jail.jails.release('i1');

  // the VM owned root/ and swapped the path to its bind for a symlink
  mkdirSync(elsewhere);
  rmSync(join(jail.root, jail.paths.dir.split('/')[1] ?? ''), { recursive: true });
  symlinkSync(elsewhere, join(jail.root, jail.paths.dir.split('/')[1] ?? ''));

  await jail.jails.prepare(plan);

  expect(lstatSync(join(jail.root, jail.paths.dir)).isDirectory()).toBeTrue();
  expect(readdirSync(elsewhere)).toEqual([]);
});

test('a planted symlink as a snapshot file stops the prepare before any mount', async () => {
  const jail = setupJails();
  const plan = { impId: 'i1', user: USER, paths: jail.paths, readOnlyFiles: [] };

  mkdirSync(jail.paths.snapshotDir, { recursive: true });
  writeFileSync(jail.paths.memFile, '');
  symlinkSync('/etc/hostname', jail.paths.vmstate);

  const error = await readRejection(jail.jails.prepare(plan));

  expect(readErrorMessage(error)).toContain('not a regular file');
  expect(jail.mounted).toEqual([]);
});

test('run/ belongs to the VM until the seal; a symlink in its place is replaced', async () => {
  const jail = setupJails();
  const plan = { impId: 'i1', user: USER, paths: jail.paths, readOnlyFiles: [] };

  symlinkSync(jail.dataDir, jail.paths.runDir);

  await jail.jails.prepare(plan);

  expect(lstatSync(jail.paths.runDir).isDirectory()).toBeTrue();
  expect(lstatSync(jail.paths.snapshotDir).mode & 0o777).toBe(0o755);

  chmodSync(jail.paths.runDir, 0o700);

  // what a start leaves: impd's log and pid file
  writeFileSync(jail.paths.logFile, 'boot\n');
  writeFileSync(jail.paths.pidFile, '1\n');

  jail.jails.seal(jail.paths, 4242);

  expect(lstatSync(jail.paths.runDir).mode & 0o777).toBe(0o755);
  expect(readdirSync(jail.paths.runDir).toSorted()).toEqual(['firecracker.log', 'pid']);
  expect(readFileSync(jail.paths.pidFile, 'utf8')).toBe('4242\n');
});

// what a VM could leave before the seal, each on its own
const PLANTS: Record<string, (paths: ImpPaths) => void> = {
  'a dir': (paths) => {
    mkdirSync(join(paths.runDir, 'planted', 'deep'), { recursive: true });
  },
  'a FIFO': (paths) => {
    Bun.spawnSync(['mkfifo', join(paths.runDir, 'fifo')]);
  },
  'a second link to the log': (paths) => {
    linkSync(paths.logFile, join(paths.runDir, 'log-link'));
  },
  'a symlink as the pid file': (paths) => {
    rmSync(paths.pidFile);
    symlinkSync('/etc/hostname', paths.pidFile);
  },
};

for (const [what, plant] of Object.entries(PLANTS)) {
  test(`a seal fails on ${what} in run/ and deletes nothing; the next prepare does`, async () => {
    const jail = setupJails();
    const plan = { impId: 'i1', user: USER, paths: jail.paths, readOnlyFiles: [] };

    await jail.jails.prepare(plan);

    writeFileSync(jail.paths.logFile, 'boot\n');
    writeFileSync(jail.paths.pidFile, '1\n');
    plant(jail.paths);

    const planted = readdirSync(jail.paths.runDir).toSorted();

    expect(() => {
      jail.jails.seal(jail.paths, 4242);
    }).toThrow('a VM that writes there is compromised');

    // nothing recursed while the VM ran, and the pid file is not rewritten
    expect(readdirSync(jail.paths.runDir).toSorted()).toEqual(planted);
    expect(lstatSync(jail.paths.runDir).mode & 0o777).toBe(0o755);

    await jail.jails.release('i1');
    await jail.jails.prepare(plan);

    // impd's own log and pid file stay, as regular files
    for (const name of readdirSync(jail.paths.runDir)) {
      expect(['firecracker.log', 'pid']).toContain(name);
      expect(lstatSync(join(jail.paths.runDir, name)).isFile()).toBeTrue();
    }
  });
}

test('a wake loads its snapshot beside nothing the last VM left in run/', async () => {
  const jail = setupJails();
  const plan = { impId: 'i1', user: USER, paths: jail.paths, readOnlyFiles: [] };

  mkdirSync(jail.paths.snapshotDir, { recursive: true });
  writeFileSync(jail.paths.vmstate, 'vmstate');
  writeFileSync(jail.paths.memFile, 'mem');

  // planted by the last VM, after its seal and before its kill
  mkdirSync(join(jail.paths.runDir, 'planted'), { recursive: true });
  writeFileSync(join(jail.paths.runDir, 'planted', 'payload'), 'x');
  writeFileSync(join(jail.paths.runDir, 'api.sock'), 'not a socket');

  Bun.spawnSync(['mkfifo', join(jail.paths.runDir, 'fifo')]);

  await jail.jails.prepare(plan);

  expect(readdirSync(jail.paths.runDir)).toEqual([]);
  expect(lstatSync(jail.paths.vmstate).mode & 0o777).toBe(0o640);
  expect(lstatSync(jail.paths.memFile).mode & 0o777).toBe(0o640);
});

test('no process of the jail uid outlives its VM: the cgroup and each pid are killed', async () => {
  const escaped = Bun.spawn(['sleep', '30']);
  const killed: string[] = [];

  const jail = setupJails(undefined, undefined, {
    killCgroup: (impId) => {
      killed.push(impId);
    },
    listUidPids: (uid) => (uid === 900_001 && escaped.exitCode === null ? [escaped.pid] : []),

    // as the jail's uid would be: the test's own process
    killUidPid: (pid, uid) => {
      killed.push(`${String(pid)} as ${String(uid)}`);
      escaped.kill('SIGKILL');
    },
  });

  const plan = {
    impId: 'i1',
    user: { uid: 900_001, gid: 900_001 },
    paths: jail.paths,
    readOnlyFiles: [],
  };

  // as a non-root test the chown to 900001 fails after the kill; root gets on
  await jail.jails.prepare(plan).catch(() => null);

  await escaped.exited;

  // until the exit reaches the test, each scan finds it again
  expect([...new Set(killed)]).toEqual(['i1', `${String(escaped.pid)} as 900001`]);
  expect(escaped.signalCode).toBe('SIGKILL');
});

test('a jail uid process that will not die refuses the next start', async () => {
  // above pid_max: no process to hit, and it never goes away
  const jail = setupJails(undefined, undefined, { listUidPids: () => [4_194_305] });

  const error = await readRejection(
    jail.jails.prepare({
      impId: 'i1',
      user: { uid: 900_001, gid: 900_001 },
      paths: jail.paths,
      readOnlyFiles: [],
    }),
  );

  expect(readErrorMessage(error)).toContain('uid 900001 still runs processes');
  expect(jail.mounted).toEqual([]);
});

test('an orphan jail that will not unmount is logged and kept; the sweep goes on', async () => {
  const jail = setupJails(
    () => false,
    (target) => target.includes('/i1/'),
  );

  const plan = { impId: 'i1', user: USER, paths: jail.paths, readOnlyFiles: [] };

  await jail.jails.prepare(plan);
  await jail.jails.prepare({ ...plan, impId: 'i2' });

  const removed = await jail.jails.removeOrphans(new Set());

  expect(removed).toEqual(['i2']);
  expect(jail.logs.join('\n')).toContain('jail i1:');
  expect(existsSync(jail.root)).toBeTrue();
});

test('an unjailed start sweeps what a jailed VM planted, so its seal passes', async () => {
  const jail = setupJails();
  const plan = { impId: 'i1', user: USER, paths: jail.paths, readOnlyFiles: [] };

  await jail.jails.prepare(plan);

  // the jailed VM's leftovers, then a switch to IMP_JAILER=false
  mkdirSync(join(jail.paths.runDir, 'planted', 'deep'), { recursive: true });
  symlinkSync('/etc/hostname', jail.paths.pidFile);

  await jail.jails.sweepRunDir(jail.paths);

  expect(jail.mounted).toEqual([]);
  expect(readdirSync(jail.paths.runDir)).toEqual([]);

  // what an unjailed start leaves before its seal
  writeFileSync(jail.paths.logFile, 'boot\n');

  jail.jails.seal(jail.paths, 4242);

  expect(readdirSync(jail.paths.runDir).toSorted()).toEqual(['firecracker.log', 'pid']);
});
