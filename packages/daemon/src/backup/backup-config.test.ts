import { expect, test } from 'bun:test';
import { loadBackupConfig, parseBackupKeep } from './backup-config';

test('backups are off without a repository', () => {
  expect(loadBackupConfig({})).toBeNull();
});

test('a repository needs a password file and takes the defaults', () => {
  expect(() => loadBackupConfig({ IMP_BACKUP_REPOSITORY: 's3:http://minio/imp' })).toThrow(
    'IMP_BACKUP_REPOSITORY needs IMP_BACKUP_PASSWORD_FILE',
  );

  expect(
    loadBackupConfig({
      IMP_BACKUP_REPOSITORY: 's3:http://minio/imp',
      IMP_BACKUP_PASSWORD_FILE: '/etc/imp/restic-password',
    }),
  ).toEqual({
    repository: 's3:http://minio/imp',
    passwordFile: '/etc/imp/restic-password',
    intervalS: 21_600,
    keep: { hourly: 24, daily: 7, weekly: 4 },
    forget: true,
    cpus: 2,
    memoryMib: 512,
  });
});

test('it parses retention and refuses one that keeps nothing', () => {
  expect(parseBackupKeep('daily=14')).toEqual({ hourly: 0, daily: 14, weekly: 0 });
  expect(() => parseBackupKeep('monthly=3')).toThrow('is not hourly|daily|weekly=<count>');
  expect(() => parseBackupKeep('daily=0')).toThrow('keeps nothing');
});
