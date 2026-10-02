import { expect, test } from 'bun:test';
import type { CommandResult } from '../process/run-command';
import type { BackupConfig } from './backup-config';
import { createRestic, parseBackupSummary, parseSnapshots } from './restic';

const CONFIG: BackupConfig = {
  repository: 's3:http://127.0.0.1:9000/imp',
  passwordFile: '/run/secrets/restic',
  intervalS: 21_600,
  keep: { hourly: 24, daily: 7, weekly: 4 },
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

  expect(recorder.argvs).toEqual(['nice -n 19 ionice -c 3 restic unlock --quiet']);

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

  expect(missing.argvs.map((argv) => argv.split(' restic ')[1])).toEqual([
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

  expect(recorder.argvs.map((argv) => argv.split(' restic ')[1])).toEqual([
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
    'Error: restic check exited 1: Fatal: pack 9f2c: ciphertext verification failed',
  );
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
