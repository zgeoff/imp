import { faker } from '@faker-js/faker';
import type { BackupConfig, BackupKeep } from '../backup/backup-config';

type BackupConfigOverrides = Partial<Omit<BackupConfig, 'keep'>> & {
  readonly keep?: Partial<BackupKeep>;
};

// impd's backup settings, as loadBackupConfig reads them: arbitrary paths,
// interval and limits, retention in every bucket, and forget on. A keep
// override merges into the default retention.
export function buildMockBackupConfig(
  overrides: Readonly<BackupConfigOverrides> = {},
): BackupConfig {
  const { keep, ...rest } = overrides;

  return {
    repository: `/srv/${faker.string.alphanumeric(8)}`,
    passwordFile: `/etc/imp/${faker.string.alphanumeric(8)}`,
    intervalS: faker.number.int({ min: 60, max: 86_400 }),
    forget: true,
    cpus: faker.number.int({ min: 1, max: 8 }),
    memoryMib: faker.number.int({ min: 64, max: 4096 }),
    ...rest,
    keep: {
      hourly: faker.number.int({ min: 1, max: 48 }),
      daily: faker.number.int({ min: 1, max: 30 }),
      weekly: faker.number.int({ min: 1, max: 12 }),
      ...keep,
    },
  };
}
