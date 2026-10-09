import { expect, test } from 'bun:test';
import { updateEnv } from '@imp/test-utils/update-env';
import { waitFor } from '@imp/test-utils/wait-for';
import * as z from 'zod';
import { buildMockBackupConfig } from '../test-utils/build-mock-backup-config';
import { buildStubResticLockRunner } from '../test-utils/build-stub-restic-lock-runner';
import { buildStubResticRunner } from '../test-utils/build-stub-restic-runner';
import {
  ResticError,
  createRestic,
  isResticLocked,
  parseBackupSummary,
  parseSnapshots,
} from './restic';

test('#createRestic runs restic at the lowest priority with a capped Go runtime', async () => {
  const runner = buildStubResticRunner();

  const restic = createRestic({
    config: buildMockBackupConfig({
      repository: 's3:http://127.0.0.1:9000/imp',
      passwordFile: '/run/secrets/restic',
      cpus: 2,
      memoryMib: 512,
    }),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  await restic.unlock();

  expect(runner.argvs).toStrictEqual([
    'nice -n 19 ionice -c 3 restic --retry-lock 2m unlock --quiet',
  ]);

  expect(runner.envs[0]).toMatchObject({
    RESTIC_REPOSITORY: 's3:http://127.0.0.1:9000/imp',
    RESTIC_PASSWORD_FILE: '/run/secrets/restic',
    RESTIC_CACHE_DIR: '/data/backup/cache',
    GOMAXPROCS: '2',
    GOMEMLIMIT: '512MiB',
  });
});

test('#createRestic passes restic none of impd’s secrets', async () => {
  updateEnv('TAILSCALE_AUTHKEY', 'tskey-not-for-restic');
  updateEnv('RESTIC_PASSWORD', 'not-for-restic');
  updateEnv('AWS_ACCESS_KEY_ID', 'AKIAEXAMPLE');

  const runner = buildStubResticRunner();

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  await restic.unlock();

  expect(runner.envs[0]).not.toContainAnyKeys(['TAILSCALE_AUTHKEY', 'RESTIC_PASSWORD']);
  expect(runner.envs[0]).toContainEntry(['AWS_ACCESS_KEY_ID', 'AKIAEXAMPLE']);
});

test('#setupRepository creates the repository when restic reports there is none', async () => {
  const runner = buildStubResticRunner([
    { exitCode: 10, stdout: '', stderr: 'repository does not exist' },
  ]);

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  await restic.setupRepository();

  expect(runner.argvs).toStrictEqual([
    'nice -n 19 ionice -c 3 restic --retry-lock 2m cat config --quiet',
    'nice -n 19 ionice -c 3 restic --retry-lock 2m init --quiet',
  ]);
});

test('#setupRepository leaves a repository that exists', async () => {
  const runner = buildStubResticRunner();

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  await restic.setupRepository();

  expect(runner.argvs).toStrictEqual([
    'nice -n 19 ionice -c 3 restic --retry-lock 2m cat config --quiet',
  ]);
});

test('#setupRepository rejects a repository restic cannot read', () => {
  const runner = buildStubResticRunner([
    { exitCode: 1, stdout: '', stderr: 'Fatal: wrong password' },
  ]);

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  expect(restic.setupRepository()).rejects.toThrowWithMessage(
    ResticError,
    'restic cat config exited 1: Fatal: wrong password',
  );
});

test('#backup tags the snapshot and reads its summary', async () => {
  const summary = JSON.stringify({
    message_type: 'summary',
    snapshot_id: 'a1b2c3',
    files_new: 3,
    files_changed: 1,
    files_unmodified: 5,
    data_added: 4096,
  });

  const runner = buildStubResticRunner([{ exitCode: 0, stdout: `{}\n${summary}\n`, stderr: '' }]);

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  const read = await restic.backup('/data/backup/tree', ['run=r1', 'imp=web']);

  expect(read).toStrictEqual({
    snapshotId: 'a1b2c3',
    filesNew: 3,
    filesChanged: 1,
    filesUnmodified: 5,
    dataAddedBytes: 4096,
  });

  expect(runner.argvs).toStrictEqual([
    'nice -n 19 ionice -c 3 restic --retry-lock 2m backup --json --host impd --tag imp-backup --tag run=r1 --tag imp=web /data/backup/tree',
  ]);
});

test('#forget forgets only impd’s snapshots, grouped by host', async () => {
  const runner = buildStubResticRunner();

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  await restic.forget({ hourly: 24, daily: 7, weekly: 4 });

  expect(runner.argvs).toStrictEqual([
    'nice -n 19 ionice -c 3 restic --retry-lock 2m forget --quiet --tag imp-backup --group-by host --keep-hourly 24 --keep-daily 7 --keep-weekly 4',
  ]);
});

test('#restore restores a snapshot’s dir sparsely, limited to the includes', async () => {
  const runner = buildStubResticRunner();

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  await restic.restore('a1b2c3', '/data/backup/tree', '/data/backup/restore/x', ['/imps/i1']);

  expect(runner.argvs).toStrictEqual([
    'nice -n 19 ionice -c 3 restic --retry-lock 2m restore --quiet --sparse --target /data/backup/restore/x --include /imps/i1 a1b2c3:/data/backup/tree',
  ]);
});

test('#check reports the last line of restic’s output when it fails', () => {
  const runner = buildStubResticRunner([
    {
      exitCode: 1,
      stdout: '',
      stderr: 'reading pack\nFatal: pack 9f2c: ciphertext verification failed\n',
    },
  ]);

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  expect(restic.check('1/5')).rejects.toThrowWithMessage(
    ResticError,
    'restic check exited 1: Fatal: pack 9f2c: ciphertext verification failed',
  );
});

test('#prune names the lock holder from plain output, without the unlock hint', () => {
  const runner = buildStubResticRunner([
    {
      exitCode: 11,
      stdout: '',
      stderr:
        'unable to create lock in backend: repository is already locked exclusively by PID 1292 on imp-zfs by root\nthe `unlock` command can be used to remove stale locks\n',
    },
  ]);

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  expect(restic.prune()).rejects.toThrowWithMessage(
    ResticError,
    'restic prune exited 11: unable to create lock in backend: repository is already locked exclusively by PID 1292 on imp-zfs by root',
  );
});

test('#listSnapshots names the lock holder from --json output, without the unlock hint', () => {
  const runner = buildStubResticRunner([
    {
      exitCode: 11,
      stdout: '',
      stderr: `${JSON.stringify({
        message_type: 'exit_error',
        code: 11,
        message:
          'unable to create lock in backend: repository is already locked exclusively by PID 1292 on imp-zfs by root\nthe `unlock` command can be used to remove stale locks',
      })}\n`,
    },
  ]);

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  expect(restic.listSnapshots()).rejects.toThrowWithMessage(
    ResticError,
    'restic snapshots exited 11: unable to create lock in backend: repository is already locked exclusively by PID 1292 on imp-zfs by root',
  );
});

test('#prune names the lock holder past the line --retry-lock prints while it waits', () => {
  // restic 0.19.1's text, with the line it can print first while it waits
  const runner = buildStubResticRunner([
    {
      exitCode: 11,
      stdout: '',
      stderr: [
        'repo already locked, waiting up to 2m0s for the lock',
        'unable to create lock in backend: repository is already locked exclusively by PID 40 on 78a6135f8901 by root (UID 0, GID 0)',
        'lock was created at 2026-10-02 07:41:13 (2.477798054s ago)',
        'storage ID ab39f58b',
        'the `unlock` command can be used to remove stale locks',
      ].join('\n'),
    },
  ]);

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  expect(restic.prune()).rejects.toThrowWithMessage(
    ResticError,
    'restic prune exited 11: unable to create lock in backend: repository is already locked exclusively by PID 40 on 78a6135f8901 by root (UID 0, GID 0)',
  );
});

test('#isResticLocked reports a restic exit 11 as locked', () => {
  expect(isResticLocked(new ResticError('restic prune exited 11: locked', 11))).toBeTrue();
});

test('#isResticLocked reports another restic exit as not locked', () => {
  expect(isResticLocked(new ResticError('restic prune exited 1: failed', 1))).toBeFalse();
});

test('#isResticLocked reports a plain error that names exit 11 as not locked', () => {
  expect(isResticLocked(new Error('restic prune exited 11'))).toBeFalse();
});

test('#restore rejects a snapshot that is gone as NOT_FOUND', () => {
  const runner = buildStubResticRunner([
    {
      exitCode: 1,
      stdout: '',
      stderr: 'Fatal: failed to find snapshot: no matching ID found for prefix "deadbeef"\n',
    },
  ]);

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  expect(
    restic.restore('deadbeef', '/data/backup/tree', '/data/backup/x', []),
  ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'backup deadbeef not found' });
});

test('#dump rejects a snapshot that is gone as NOT_FOUND', () => {
  const runner = buildStubResticRunner([
    {
      exitCode: 1,
      stdout: '',
      stderr: 'Fatal: failed to find snapshot: no matching ID found for prefix "deadbeef"\n',
    },
  ]);

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  expect(restic.dump('deadbeef', '/data/backup/tree/manifest.json')).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: 'backup deadbeef not found',
  });
});

test('#dump rejects another restic failure as a ResticError', () => {
  const runner = buildStubResticRunner([
    { exitCode: 1, stdout: '', stderr: 'Fatal: unable to open config file\n' },
  ]);

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  expect(restic.dump('a1b2c3', '/data/backup/tree/manifest.json')).rejects.toThrowWithMessage(
    ResticError,
    'restic dump exited 1: Fatal: unable to open config file',
  );
});

test('#listSnapshots lists snapshots while a prune holds the lock', async () => {
  const runner = buildStubResticLockRunner();

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  void restic.prune();

  await waitFor(() => {
    expect(runner.events).toStrictEqual(['start prune']);
  });

  const listed = restic.listSnapshots();

  await waitFor(() => {
    expect(runner.events).toStrictEqual(['start prune', 'start snapshots']);
  });

  runner.stopCommand('snapshots');

  const snapshots = await listed;

  expect(snapshots).toStrictEqual([]);
  expect(runner.events).toStrictEqual(['start prune', 'start snapshots', 'end snapshots']);
});

test('#prune prunes while a snapshot list runs', async () => {
  const runner = buildStubResticLockRunner();

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  void restic.listSnapshots();

  await waitFor(() => {
    expect(runner.events).toStrictEqual(['start snapshots']);
  });

  const pruned = restic.prune();

  await waitFor(() => {
    expect(runner.events).toStrictEqual(['start snapshots', 'start prune']);
  });

  runner.stopCommand('prune');

  await pruned;

  expect(runner.events).toStrictEqual(['start snapshots', 'start prune', 'end prune']);
});

test('#prune waits for a backup that holds the lock', async () => {
  const runner = buildStubResticLockRunner();

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  const backup = restic.backup('/data/backup/tree', []);

  await waitFor(() => {
    expect(runner.events).toStrictEqual(['start backup']);
  });

  const pruned = restic.prune();

  await waitFor(() => {
    expect(runner.events).toStrictEqual(['start backup', 'wait prune']);
  });

  runner.stopCommand('backup');

  await waitFor(() => {
    expect(runner.events).toContain('start prune');
  });

  runner.stopCommand('prune');

  await Promise.all([backup, pruned]);

  expect(runner.events).toStrictEqual([
    'start backup',
    'wait prune',
    'end backup',
    'start prune',
    'end prune',
  ]);
});

test('#prune waits for a check that holds the lock', async () => {
  const runner = buildStubResticLockRunner();

  const restic = createRestic({
    config: buildMockBackupConfig(),
    cacheDir: '/data/backup/cache',
    run: runner.run,
  });

  const checked = restic.check('1/5');

  await waitFor(() => {
    expect(runner.events).toStrictEqual(['start check']);
  });

  const pruned = restic.prune();

  await waitFor(() => {
    expect(runner.events).toStrictEqual(['start check', 'wait prune']);
  });

  runner.stopCommand('check');

  await waitFor(() => {
    expect(runner.events).toContain('start prune');
  });

  runner.stopCommand('prune');

  await Promise.all([checked, pruned]);

  expect(runner.events).toStrictEqual([
    'start check',
    'wait prune',
    'end check',
    'start prune',
    'end prune',
  ]);
});

test('#parseSnapshots lists snapshots oldest first and reads no tags as none', () => {
  const stdout = JSON.stringify([
    {
      id: 'b',
      time: '2026-10-02T06:00:00.5+10:00',
      paths: ['/data/backup/tree'],
      tags: ['imp-backup'],
    },
    { id: 'a', time: '2026-10-01T18:00:00Z', paths: ['/data/backup/tree'], tags: null },
  ]);

  expect(parseSnapshots(stdout)).toStrictEqual([
    { id: 'a', time: new Date('2026-10-01T18:00:00Z'), paths: ['/data/backup/tree'], tags: [] },
    {
      id: 'b',
      time: new Date('2026-10-01T20:00:00.5Z'),
      paths: ['/data/backup/tree'],
      tags: ['imp-backup'],
    },
  ]);
});

test('#parseSnapshots reads empty output as no snapshots', () => {
  expect(parseSnapshots('')).toStrictEqual([]);
});

test('#parseBackupSummary rejects backup output without a summary', () => {
  expect(() => parseBackupSummary('{"message_type":"status"}\n')).toThrow(z.ZodError);
});
