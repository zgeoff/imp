import { expect, test } from 'bun:test';
import type { CommandResult } from '../process/run-command';
import type { BackupConfig } from './backup-config';
import { createRestic, isResticLocked, parseBackupSummary, parseSnapshots } from './restic';

const CONFIG: BackupConfig = {
  repository: 's3:http://127.0.0.1:9000/imp',
  passwordFile: '/run/secrets/restic',
  intervalS: 21_600,
  keep: { hourly: 24, daily: 7, weekly: 4 },
  forget: true,
  cpus: 2,
  memoryMib: 512,
};

function setupRecorder(results: readonly CommandResult[] = []) {
  const argvs: string[] = [];
  const envs: Readonly<Record<string, string>>[] = [];
  let next = 0;

  const restic = createRestic({
    config: CONFIG,
    cacheDir: '/data/backup/cache',
    run: (argv, env) => {
      argvs.push(argv.join(' '));
      envs.push(env);

      const result = results[next] ?? { exitCode: 0, stdout: '', stderr: '' };

      next += 1;

      return Promise.resolve(result);
    },
  });

  return { restic, argvs, envs };
}

test('it runs restic at the lowest priority with a capped Go runtime and no impd secrets', async () => {
  const saved = process.env['TAILSCALE_AUTHKEY'];

  process.env['TAILSCALE_AUTHKEY'] = 'tskey-not-for-restic';

  const recorder = setupRecorder();

  await recorder.restic.unlock();

  if (saved === undefined) {
    delete process.env['TAILSCALE_AUTHKEY'];
  } else {
    process.env['TAILSCALE_AUTHKEY'] = saved;
  }

  expect(recorder.argvs).toEqual(['nice -n 19 ionice -c 3 restic --retry-lock 2m unlock --quiet']);

  expect(recorder.envs[0]).toMatchObject({
    RESTIC_REPOSITORY: CONFIG.repository,
    RESTIC_PASSWORD_FILE: CONFIG.passwordFile,
    RESTIC_CACHE_DIR: '/data/backup/cache',
    GOMAXPROCS: '2',
    GOMEMLIMIT: '512MiB',
  });

  expect(recorder.envs[0]).not.toHaveProperty('TAILSCALE_AUTHKEY');
  expect(recorder.envs[0]).not.toHaveProperty('RESTIC_PASSWORD');
});

test('it creates the repository only when restic reports there is none', async () => {
  const missing = setupRecorder([
    { exitCode: 10, stdout: '', stderr: 'repository does not exist' },
  ]);

  await missing.restic.setupRepository();

  expect(missing.argvs.map((argv) => argv.split(' restic --retry-lock 2m ')[1])).toEqual([
    'cat config --quiet',
    'init --quiet',
  ]);

  const present = setupRecorder();

  await present.restic.setupRepository();

  expect(present.argvs).toHaveLength(1);

  const locked = setupRecorder([{ exitCode: 1, stdout: '', stderr: 'Fatal: wrong password' }]);

  const lockedError = await locked.restic.setupRepository().catch(String);

  expect(lockedError).toContain('wrong password');
});

test('it tags every backup and limits forget to impd snapshots', async () => {
  const summary = JSON.stringify({
    message_type: 'summary',
    snapshot_id: 'a1b2c3',
    files_new: 3,
    files_changed: 1,
    files_unmodified: 5,
    data_added: 4096,
  });

  const recorder = setupRecorder([{ exitCode: 0, stdout: `{}\n${summary}\n`, stderr: '' }]);

  const summaryRead = await recorder.restic.backup('/data/backup/tree', ['run=r1', 'imp=web']);

  expect(summaryRead).toEqual({
    snapshotId: 'a1b2c3',
    filesNew: 3,
    filesChanged: 1,
    filesUnmodified: 5,
    dataAddedBytes: 4096,
  });

  await recorder.restic.forget(CONFIG.keep);

  await recorder.restic.restore('a1b2c3', '/data/backup/tree', '/data/backup/restore/x', [
    '/imps/i1',
  ]);

  expect(recorder.argvs.map((argv) => argv.split(' restic --retry-lock 2m ')[1])).toEqual([
    'backup --json --host impd --tag imp-backup --tag run=r1 --tag imp=web /data/backup/tree',
    'forget --quiet --tag imp-backup --group-by host --keep-hourly 24 --keep-daily 7 --keep-weekly 4',
    'restore --quiet --sparse --target /data/backup/restore/x --include /imps/i1 a1b2c3:/data/backup/tree',
  ]);
});

test('it reports the last line of restic output when a command fails', async () => {
  const recorder = setupRecorder([
    {
      exitCode: 1,
      stdout: '',
      stderr: 'reading pack\nFatal: pack 9f2c: ciphertext verification failed\n',
    },
  ]);

  const checkError = await recorder.restic.check('1/5').catch(String);

  expect(checkError).toBe(
    'ResticError: restic check exited 1: Fatal: pack 9f2c: ciphertext verification failed',
  );
});

test('a lock failure names the holder, from plain or --json output', async () => {
  const held = 'repository is already locked exclusively by PID 1292 on imp-zfs by root';
  const hint = 'the `unlock` command can be used to remove stale locks';

  const recorder = setupRecorder([
    { exitCode: 11, stdout: '', stderr: `unable to create lock in backend: ${held}\n${hint}\n` },
    {
      exitCode: 11,
      stdout: '',
      stderr: `${JSON.stringify({ message_type: 'exit_error', code: 11, message: `unable to create lock in backend: ${held}\n${hint}` })}\n`,
    },
  ]);

  const pruneError = await recorder.restic.prune().catch((error: unknown) => error);
  const listError = await recorder.restic.listSnapshots().catch((error: unknown) => error);

  for (const error of [pruneError, listError]) {
    expect(String(error)).toContain(held);
    expect(String(error)).not.toContain(hint);
    expect(isResticLocked(error)).toBeTrue();
  }

  expect(isResticLocked(new Error('restic prune exited 11'))).toBeFalse();
});

const LOCKING_OUTPUT: Readonly<Record<string, string>> = {
  snapshots: '[]',
  backup: JSON.stringify({
    message_type: 'summary',
    snapshot_id: 'a1',
    files_new: 0,
    files_changed: 0,
    files_unmodified: 0,
    data_added: 0,
  }),
};

test('with --retry-lock, the lock failure is still the line that names the holder', async () => {
  // restic 0.19.1's text, with the line it can print first while it waits
  const stderr = [
    'repo already locked, waiting up to 2m0s for the lock',
    'unable to create lock in backend: repository is already locked exclusively by PID 40 on 78a6135f8901 by root (UID 0, GID 0)',
    'lock was created at 2026-10-02 07:41:13 (2.477798054s ago)',
    'storage ID ab39f58b',
    'the `unlock` command can be used to remove stale locks',
  ].join('\n');

  const recorder = setupRecorder([{ exitCode: 11, stdout: '', stderr }]);

  const error = await recorder.restic.prune().catch(String);

  expect(error).toBe(
    'ResticError: restic prune exited 11: unable to create lock in backend: repository is already locked exclusively by PID 40 on 78a6135f8901 by root (UID 0, GID 0)',
  );
});

test('a snapshot that is gone is NOT_FOUND for a restore or a dump', async () => {
  const gone = {
    exitCode: 1,
    stdout: '',
    stderr: 'Fatal: failed to find snapshot: no matching ID found for prefix "deadbeef"\n',
  };

  const recorder = setupRecorder([gone, gone]);

  const restoreError = await recorder.restic
    .restore('deadbeef', '/data/backup/tree', '/tmp/x', [])
    .catch((error: unknown) => error);

  const dumpError = await recorder.restic
    .dump('deadbeef', '/data/backup/tree/manifest.json')
    .catch((error: unknown) => error);

  for (const error of [restoreError, dumpError]) {
    expect(error).toMatchObject({ code: 'NOT_FOUND', message: 'backup deadbeef not found' });
  }
});

// restic's own lock rule over one repository: forget, prune and check take
// it alone, the rest share it, and --no-lock takes none. A command that
// meets a lock it cannot share exits 11, unless --retry-lock lets it wait.
function setupLockingRestic() {
  const lock = { exclusive: false, shared: 0 };

  const exclusiveCommands = new Set(['forget', 'prune', 'check']);

  const run = async (argv: readonly string[]): Promise<CommandResult> => {
    const args = argv.slice(argv.indexOf('restic') + 1);
    const retries = args[0] === '--retry-lock';
    const rest = retries ? args.slice(2) : args;
    const command = rest[0] ?? '';
    const exclusive = exclusiveCommands.has(command);
    const locks = !rest.includes('--no-lock');
    const isBlocked = () => locks && (lock.exclusive || (exclusive && lock.shared > 0));

    while (isBlocked()) {
      if (!retries) {
        return { exitCode: 11, stdout: '', stderr: 'unable to create lock in backend\n' };
      }

      await Bun.sleep(5);
    }

    if (locks && exclusive) {
      lock.exclusive = true;
    } else if (locks) {
      lock.shared += 1;
    }

    // the command's work, long enough for the other to start meanwhile
    await Bun.sleep(30);

    if (locks && exclusive) {
      lock.exclusive = false;
    } else if (locks) {
      lock.shared -= 1;
    }

    return { exitCode: 0, stdout: LOCKING_OUTPUT[command] ?? '', stderr: '' };
  };

  return createRestic({ config: CONFIG, cacheDir: '/data/backup/cache', run });
}

test('a prune and a snapshots list at once both succeed, in either order', async () => {
  const restic = setupLockingRestic();

  const pruneFirst = await Promise.all([restic.prune(), restic.listSnapshots()]);

  expect(pruneFirst).toEqual([undefined, []]);

  const listFirst = await Promise.all([restic.listSnapshots(), restic.prune()]);

  expect(listFirst).toEqual([[], undefined]);
});

test('a prune waits for a backup or a check that holds the lock', async () => {
  const restic = setupLockingRestic();

  const [backup] = await Promise.all([restic.backup('/data/backup/tree', []), restic.prune()]);

  expect(backup.snapshotId).toBe('a1');

  await Promise.all([restic.check('1/5'), restic.prune()]);
});

test('it lists snapshots oldest first and tolerates untagged ones', () => {
  const stdout = JSON.stringify([
    {
      id: 'b',
      time: '2026-10-02T06:00:00.5+10:00',
      paths: ['/data/backup/tree'],
      tags: ['imp-backup'],
    },
    { id: 'a', time: '2026-10-01T18:00:00Z', paths: ['/data/backup/tree'], tags: null },
  ]);

  expect(parseSnapshots(stdout)).toEqual([
    { id: 'a', time: new Date('2026-10-01T18:00:00Z'), paths: ['/data/backup/tree'], tags: [] },
    {
      id: 'b',
      time: new Date('2026-10-01T20:00:00.5Z'),
      paths: ['/data/backup/tree'],
      tags: ['imp-backup'],
    },
  ]);

  expect(parseSnapshots('')).toEqual([]);
});

test('it refuses backup output without a summary', () => {
  expect(() => parseBackupSummary('{"message_type":"status"}\n')).toThrow();
});
