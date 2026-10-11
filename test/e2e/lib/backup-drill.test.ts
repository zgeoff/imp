import { expect, test } from 'bun:test';
import { buildBackupEnv, findPackKey } from './backup-drill';

test('#buildBackupEnv points impd at the drill repository with its keys and schedule', () => {
  expect(
    buildBackupEnv(
      {
        dir: '/repo/.cache/e2e/backups-a1',
        envFile: '/repo/.cache/e2e/backups-a1/restic.env',
        passwordInContainer: '/src/.cache/e2e/backups-a1/restic-password',
        accessKey: 'e2e-backups',
        secretKey: 'f00d',
      },
      60,
    ),
  ).toStrictEqual({
    IMP_BACKUP_REPOSITORY: 's3:http://127.0.0.1:9000/imp-e2e',
    IMP_BACKUP_PASSWORD_FILE: '/src/.cache/e2e/backups-a1/restic-password',
    IMP_BACKUP_INTERVAL_S: '60',
    IMP_BACKUP_MEMORY_MIB: '256',
    IMP_DEV_BACKUP_ENV_FILE: '/repo/.cache/e2e/backups-a1/restic.env',
  });
});

test('#findPackKey reads the first data pack of a listing', () => {
  const listing = [
    '<ListBucketResult><Name>imp-e2e</Name>',
    '<Contents><Key>data/3f/3f9a</Key></Contents>',
    '<Contents><Key>data/a0/a0b1</Key></Contents>',
    '</ListBucketResult>',
  ].join('');

  expect(findPackKey(listing)).toBe('data/3f/3f9a');
});

test('#findPackKey reads a listing without packs as none', () => {
  expect(findPackKey('<ListBucketResult><Name>imp-e2e</Name></ListBucketResult>')).toBeUndefined();
});
