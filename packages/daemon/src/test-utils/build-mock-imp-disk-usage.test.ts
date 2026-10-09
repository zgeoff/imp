import { expect, test } from 'bun:test';
import { buildMockImpDiskUsage } from './build-mock-imp-disk-usage';

test('it builds a default imp disk usage', () => {
  expect(buildMockImpDiskUsage()).toStrictEqual({
    exclusiveBytes: expect.toBeNumber(),
    sharedBytes: expect.toBeNumber(),
    isUpperBound: false,
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockImpDiskUsage({ exclusiveBytes: 10, sharedBytes: 20, isUpperBound: true }),
  ).toStrictEqual({ exclusiveBytes: 10, sharedBytes: 20, isUpperBound: true });
});
