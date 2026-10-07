import { expect, test } from 'bun:test';
import {
  BackupCheckSubsetSchema,
  BackupPointSchema,
  BackupRestoreSchema,
  BackupRunSchema,
  BackupStatusSchema,
} from './backup-schema';

test('#BackupPointSchema accepts a snapshot with its imps', () => {
  const payload = {
    id: 'a1b2c3',
    time: new Date('2026-01-02T03:04:05.000Z'),
    imps: ['dev', 'web'],
  } as const;

  expect(BackupPointSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#BackupStatusSchema accepts a status with a failed check', () => {
  const payload = {
    points: [{ id: 'a1b2c3', time: new Date('2026-01-02T03:04:05.000Z'), imps: ['dev'] }],
    lastRunAt: new Date('2026-01-02T03:04:05.000Z'),
    lastPruneAt: new Date('2026-01-02T04:05:06.000Z'),
    lastCheck: { at: new Date('2026-01-02T04:05:06.000Z'), error: 'pack 1f2e is damaged' },
  } as const;

  expect(BackupStatusSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#BackupStatusSchema accepts a status that has never run', () => {
  const payload = { points: [], lastRunAt: null, lastPruneAt: null, lastCheck: null } as const;

  expect(BackupStatusSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#BackupRunSchema accepts a run that skipped an imp', () => {
  const payload = {
    snapshotId: 'a1b2c3',
    imps: ['dev'],
    skipped: [{ name: 'web', reason: 'being created' }],
    dataAddedBytes: 2048,
    durationMs: 900,
  } as const;

  expect(BackupRunSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#BackupRunSchema rejects a negative byte count', () => {
  const result = BackupRunSchema.safeParse({
    snapshotId: 'a1b2c3',
    imps: ['dev'],
    skipped: [{ name: 'web', reason: 'being created' }],
    dataAddedBytes: -1,
    durationMs: 900,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['dataAddedBytes'], code: 'too_small' });
});

test('#BackupRunSchema rejects a fractional duration', () => {
  const result = BackupRunSchema.safeParse({
    snapshotId: 'a1b2c3',
    imps: ['dev'],
    skipped: [{ name: 'web', reason: 'being created' }],
    dataAddedBytes: 2048,
    durationMs: 0.5,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['durationMs'], code: 'invalid_type' });
});

test('#BackupRestoreSchema accepts restored imps with a skipped grant', () => {
  const payload = {
    imps: [
      {
        id: 'imp-1',
        name: 'dev',
        image: 'base',
        state: 'stopped',
        vcpus: 2,
        memoryMib: 1024,
        diskMib: 4096,
        ip: '10.0.0.2',
        slot: 1,
        port: 7001,
        httpPort: 8080,
        url: 'https://dev.example.com',
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
        lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
      },
    ],
    skippedGrants: [{ imp: 'dev', secret: 'github', reason: 'no-secret' }],
  } as const;

  expect(BackupRestoreSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#BackupRestoreSchema rejects a restored imp that is not a valid imp', () => {
  const result = BackupRestoreSchema.safeParse({
    imps: [
      {
        id: 'imp-1',
        name: 'Dev',
        image: 'base',
        state: 'stopped',
        vcpus: 2,
        memoryMib: 1024,
        diskMib: 4096,
        ip: '10.0.0.2',
        slot: 1,
        port: 7001,
        httpPort: 8080,
        url: 'https://dev.example.com',
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
        lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
      },
    ],
    skippedGrants: [{ imp: 'dev', secret: 'github', reason: 'no-secret' }],
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['imps', 0, 'name'],
    message: 'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  });
});

test.each(['1/5', '10%', '2.5%', '2G', '512K', '100'])(
  '#BackupCheckSubsetSchema accepts the subset %s',
  (input) => {
    expect(BackupCheckSubsetSchema.safeParse(input).data).toBe(input);
  },
);

test.each(['', '1/', '10 %', '2g', '2GB', '-1', '%'])(
  '#BackupCheckSubsetSchema rejects the subset %s',
  (input) => {
    const result = BackupCheckSubsetSchema.safeParse(input);

    expect(result.error?.issues).toPartiallyContain({ path: [], code: 'invalid_format' });
  },
);
