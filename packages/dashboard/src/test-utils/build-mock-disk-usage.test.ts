import { expect, test } from 'bun:test';
import { buildMockDiskUsage } from './build-mock-disk-usage';

test('it builds a default disk usage', () => {
  expect(buildMockDiskUsage()).toStrictEqual({
    exclusiveBytes: expect.toBeWithin(0, 1024 * 1024 * 1024 + 1),
    sharedBytes: expect.toBeWithin(0, 1024 * 1024 * 1024 + 1),
    measuredAt: expect.toBeValidDate(),
    isPartial: false,
    isUpperBound: false,
  });
});

test('it applies overrides on top of the defaults', () => {
  const usage = buildMockDiskUsage({ exclusiveBytes: 1536, isPartial: true });

  expect(usage).toStrictEqual({
    exclusiveBytes: 1536,
    sharedBytes: expect.toBeNumber(),
    measuredAt: expect.toBeValidDate(),
    isPartial: true,
    isUpperBound: false,
  });
});
