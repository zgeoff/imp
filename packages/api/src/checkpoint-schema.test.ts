import { expect, test } from 'bun:test';
import { CheckpointSchema } from './checkpoint-schema';

test('it accepts a checkpoint without its optional fields', () => {
  const payload = {
    id: 'cp-1',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    diskMib: 4096,
  } as const;

  expect(CheckpointSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('it accepts a checkpoint with a label and a size', () => {
  const payload = {
    id: 'cp-1',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    diskMib: 4096,
    label: 'before upgrade',
    sizeBytes: 0,
  } as const;

  expect(CheckpointSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('it rejects a negative size', () => {
  const result = CheckpointSchema.safeParse({
    id: 'cp-1',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    diskMib: 4096,
    sizeBytes: -1,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['sizeBytes'], code: 'too_small' });
});

test('it rejects a zero disk size', () => {
  const result = CheckpointSchema.safeParse({
    id: 'cp-1',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    diskMib: 0,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['diskMib'], code: 'too_small' });
});

test('it rejects a fractional disk size', () => {
  const result = CheckpointSchema.safeParse({
    id: 'cp-1',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    diskMib: 1.5,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['diskMib'], code: 'invalid_type' });
});
