import { expect, test } from 'bun:test';
import { buildMockCheckpointRecord } from './build-mock-checkpoint-record';

test('it builds a default checkpoint record', () => {
  expect(buildMockCheckpointRecord()).toStrictEqual({
    id: expect.toSatisfy((id: string) => /^[a-z0-9]{8}$/v.test(id)),
    impId: expect.toBeString(),
    label: expect.toBeString(),
    createdAt: expect.toBeValidDate(),
    sizeBytes: expect.toBeWithin(1, 1024 ** 3 + 1),
    diskBytes: expect.toBeWithin(1024 ** 3, 64 * 1024 ** 3 + 1),
  });
});

test('it applies overrides on top of the defaults', () => {
  const checkpoint = buildMockCheckpointRecord({
    id: 'cp-1',
    impId: 'imp-1',
    label: null,
    createdAt: new Date(1_800_000_000_000),
    sizeBytes: null,
    diskBytes: 1_048_576,
  });

  expect(checkpoint).toStrictEqual({
    id: 'cp-1',
    impId: 'imp-1',
    label: null,
    createdAt: new Date(1_800_000_000_000),
    sizeBytes: null,
    diskBytes: 1_048_576,
  });
});
