import { expect, test } from 'bun:test';
import {
  DatabaseCopySchema,
  DroppedStorageSchema,
  OrphanStorageSchema,
  StorageGcSchema,
} from './storage-schema';

test.each(['imp', 'checkpoint', 'image', 'snapshot', 'memory', 'secrets'])(
  '#DroppedStorageSchema accepts the kind %s',
  (kind) => {
    expect(DroppedStorageSchema.safeParse({ kind, id: 'x-1' }).data).toStrictEqual({
      kind,
      id: 'x-1',
    });
  },
);

test('#DroppedStorageSchema rejects a kind outside the list', () => {
  const result = DroppedStorageSchema.safeParse({ kind: 'token', id: 'x-1' });

  expect(result.error?.issues).toPartiallyContain({ path: ['kind'], code: 'invalid_value' });
});

test('#OrphanStorageSchema accepts an orphaned directory of secret values', () => {
  const payload = {
    kind: 'secrets',
    id: 'imp-1',
    location: '/data/secrets/imp-1',
    bytes: 512,
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    snapshots: [],
    files: ['github-token'],
  } as const;

  const result = OrphanStorageSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#OrphanStorageSchema accepts an orphaned imp with no creation time', () => {
  const payload = {
    kind: 'imp',
    id: 'imp-1',
    location: 'tank/imp/imps/imp-1',
    bytes: 1_048_576,
    createdAt: null,
    snapshots: ['cp-1'],
  } as const;

  const result = OrphanStorageSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#OrphanStorageSchema rejects a kind outside the list', () => {
  const result = OrphanStorageSchema.safeParse({
    kind: 'snapshot',
    id: 'imp-1',
    location: 'tank/imp/imps/imp-1',
    bytes: 1_048_576,
    createdAt: null,
    snapshots: ['cp-1'],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['kind'], code: 'invalid_value' });
});

test('#OrphanStorageSchema rejects a negative size', () => {
  const result = OrphanStorageSchema.safeParse({
    kind: 'imp',
    id: 'imp-1',
    location: 'tank/imp/imps/imp-1',
    bytes: -1,
    createdAt: null,
    snapshots: ['cp-1'],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['bytes'], code: 'too_small' });
});

test('#OrphanStorageSchema rejects a fractional size', () => {
  const result = OrphanStorageSchema.safeParse({
    kind: 'imp',
    id: 'imp-1',
    location: 'tank/imp/imps/imp-1',
    bytes: 1.5,
    createdAt: null,
    snapshots: ['cp-1'],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['bytes'], code: 'invalid_type' });
});

test('#StorageGcSchema accepts a dry run with kept orphans', () => {
  const payload = {
    dryRun: true,
    dropped: [{ kind: 'checkpoint', id: 'cp-1' }],
    kept: [
      {
        kind: 'image',
        id: 'base',
        location: '/data/images/base',
        bytes: 2048,
        createdAt: null,
        snapshots: [],
      },
    ],
  } as const;

  const result = StorageGcSchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#StorageGcSchema accepts a run from an impd that reports no kept orphans', () => {
  const payload = { dryRun: false, dropped: [] } as const;

  expect(StorageGcSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#StorageGcSchema rejects a dropped item of an unknown kind', () => {
  const result = StorageGcSchema.safeParse({
    dryRun: true,
    dropped: [{ kind: 'token', id: 'cp-1' }],
    kept: [],
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['dropped', 0, 'kind'],
    code: 'invalid_value',
  });
});

test('#DatabaseCopySchema accepts a database copy', () => {
  const payload = {
    path: '/data/db-copies/impd-2026-01-02.db',
    sizeBytes: 65_536,
    lastMigration: '0042_session_logs',
    impVersion: '0.40.0',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    integrity: 'ok',
  } as const;

  const result = DatabaseCopySchema.safeParse(payload);

  expect(result.data).toStrictEqual(payload);
});

test('#DatabaseCopySchema rejects a negative size', () => {
  const result = DatabaseCopySchema.safeParse({
    path: '/data/db-copies/impd-2026-01-02.db',
    sizeBytes: -1,
    lastMigration: '0042_session_logs',
    impVersion: '0.40.0',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    integrity: 'ok',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['sizeBytes'], code: 'too_small' });
});

test('#DatabaseCopySchema rejects a creation time that is not a date', () => {
  const result = DatabaseCopySchema.safeParse({
    path: '/data/db-copies/impd-2026-01-02.db',
    sizeBytes: 65_536,
    lastMigration: '0042_session_logs',
    impVersion: '0.40.0',
    createdAt: '2026-01-02T03:04:05.000Z',
    integrity: 'ok',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['createdAt'], code: 'invalid_type' });
});
