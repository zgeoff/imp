import { expect, test } from 'bun:test';
import { buildMockBackupConfig } from './build-mock-backup-config';

test('it builds a default backup config', () => {
  expect(buildMockBackupConfig()).toStrictEqual({
    repository: expect.toSatisfy((path: string) => /^\/srv\/\w{8}$/v.test(path)),
    passwordFile: expect.toSatisfy((path: string) => /^\/etc\/imp\/\w{8}$/v.test(path)),
    intervalS: expect.toBeWithin(60, 86_401),
    forget: true,
    cpus: expect.toBeWithin(1, 9),
    memoryMib: expect.toBeWithin(64, 4097),
    keep: {
      hourly: expect.toBeWithin(1, 49),
      daily: expect.toBeWithin(1, 31),
      weekly: expect.toBeWithin(1, 13),
    },
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockBackupConfig({
      repository: 's3:http://127.0.0.1:9000/imp',
      passwordFile: '/run/secrets/restic',
      intervalS: 3600,
      forget: false,
      cpus: 2,
      memoryMib: 512,
      keep: { hourly: 24, daily: 7, weekly: 4 },
    }),
  ).toStrictEqual({
    repository: 's3:http://127.0.0.1:9000/imp',
    passwordFile: '/run/secrets/restic',
    intervalS: 3600,
    forget: false,
    cpus: 2,
    memoryMib: 512,
    keep: { hourly: 24, daily: 7, weekly: 4 },
  });
});

test('it merges a keep override into the default retention', () => {
  const config = buildMockBackupConfig({ keep: { daily: 14 } });

  expect(config.keep).toStrictEqual({
    hourly: expect.toBeWithin(1, 49),
    daily: 14,
    weekly: expect.toBeWithin(1, 13),
  });
});
