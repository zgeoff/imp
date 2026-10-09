import { expect, test } from 'bun:test';
import * as z from 'zod';
import { loadBackupConfig, parseBackupKeep } from './backup-config';

test('#loadBackupConfig turns backups off without a repository', () => {
  expect(loadBackupConfig({})).toBeNull();
});

test('#loadBackupConfig rejects a repository without a password file', () => {
  expect(() => loadBackupConfig({ IMP_BACKUP_REPOSITORY: 's3:http://minio/imp' })).toThrow(
    'IMP_BACKUP_REPOSITORY needs IMP_BACKUP_PASSWORD_FILE',
  );
});

test('#loadBackupConfig takes the defaults for a repository with a password file', () => {
  expect(
    loadBackupConfig({
      IMP_BACKUP_REPOSITORY: 's3:http://minio/imp',
      IMP_BACKUP_PASSWORD_FILE: '/etc/imp/restic-password',
    }),
  ).toStrictEqual({
    repository: 's3:http://minio/imp',
    passwordFile: '/etc/imp/restic-password',
    intervalS: 21_600,
    keep: { hourly: 24, daily: 7, weekly: 4 },
    forget: true,
    cpus: 2,
    memoryMib: 512,
  });
});

test('#loadBackupConfig reads every setting from the environment', () => {
  expect(
    loadBackupConfig({
      IMP_BACKUP_REPOSITORY: '/srv/restic',
      IMP_BACKUP_PASSWORD_FILE: '/etc/imp/restic-password',
      IMP_BACKUP_INTERVAL_S: '3600',
      IMP_BACKUP_KEEP: 'weekly=2',
      IMP_BACKUP_FORGET: 'false',
      IMP_BACKUP_CPUS: '4',
      IMP_BACKUP_MEMORY_MIB: '1024',
    }),
  ).toStrictEqual({
    repository: '/srv/restic',
    passwordFile: '/etc/imp/restic-password',
    intervalS: 3600,
    keep: { hourly: 0, daily: 0, weekly: 2 },
    forget: false,
    cpus: 4,
    memoryMib: 1024,
  });
});

test.each([
  ['IMP_BACKUP_INTERVAL_S', '0'],
  ['IMP_BACKUP_CPUS', '-1'],
  ['IMP_BACKUP_MEMORY_MIB', '1.5'],
  ['IMP_BACKUP_CPUS', 'two'],
  ['IMP_BACKUP_FORGET', 'no'],
])('#loadBackupConfig rejects %s=%s', (name, value) => {
  expect(() =>
    loadBackupConfig({
      IMP_BACKUP_REPOSITORY: '/srv/restic',
      IMP_BACKUP_PASSWORD_FILE: '/etc/imp/restic-password',
      [name]: value,
    }),
  ).toThrow(expect.objectContaining({ issues: expect.toPartiallyContain({ path: [name] }) }));
});

test('#loadBackupConfig rejects an env check with a ZodError', () => {
  expect(() =>
    loadBackupConfig({
      IMP_BACKUP_REPOSITORY: '/srv/restic',
      IMP_BACKUP_PASSWORD_FILE: '/etc/imp/restic-password',
      IMP_BACKUP_CPUS: '0',
    }),
  ).toThrow(z.ZodError);
});

test('#parseBackupKeep keeps none in a bucket left out', () => {
  expect(parseBackupKeep('daily=14')).toStrictEqual({ hourly: 0, daily: 14, weekly: 0 });
});

test.each([['monthly=3'], ['daily=1.5'], ['daily=-1']])(
  '#parseBackupKeep rejects %s as not a bucket and a count',
  (value) => {
    expect(() => parseBackupKeep(value)).toThrow(
      `IMP_BACKUP_KEEP: ${JSON.stringify(value)} is not hourly|daily|weekly=<count>`,
    );
  },
);

test('#parseBackupKeep rejects a retention that keeps nothing', () => {
  expect(() => parseBackupKeep('daily=0')).toThrow('IMP_BACKUP_KEEP keeps nothing');
});
