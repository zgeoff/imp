import { expect, test } from 'bun:test';
import { buildMockCheckpoint } from './build-mock-checkpoint';

test('it builds a default checkpoint', () => {
  expect(buildMockCheckpoint()).toStrictEqual({
    id: expect.toSatisfy((value: string) => /^[a-z0-9]{10}$/.test(value)),
    createdAt: expect.toBeValidDate(),
    sizeBytes: expect.toBeWithin(0, 1024 * 1024 * 1024 + 1),
    diskMib: expect.toSatisfy((mib: number) => mib >= 1024 && mib % 1024 === 0),
  });
});

test('it applies overrides on top of the defaults', () => {
  const checkpoint = buildMockCheckpoint({ id: 'cp1', label: 'before-upgrade' });

  expect(checkpoint).toStrictEqual({
    id: 'cp1',
    label: 'before-upgrade',
    createdAt: expect.toBeValidDate(),
    sizeBytes: expect.toBeNumber(),
    diskMib: expect.toBeNumber(),
  });
});
