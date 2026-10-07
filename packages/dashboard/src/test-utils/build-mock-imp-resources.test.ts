import { expect, test } from 'bun:test';
import { buildMockImpResources } from './build-mock-imp-resources';

test('it builds a default imp resources', () => {
  expect(buildMockImpResources()).toStrictEqual({
    wakeCount: expect.toBeWithin(0, 101),
    awakeMs: expect.toBeWithin(0, 86_400_001),
    sample: {
      measuredAt: expect.toBeValidDate(),
      since: expect.toBeValidDate(),
      cpuPercent: expect.toBeWithin(0, 200.1),
      cpuThrottledMs: expect.toBeWithin(0, 60_001),
      netRxBytes: expect.toBeWithin(0, 1024 * 1024 + 1),
      netTxBytes: expect.toBeWithin(0, 1024 * 1024 + 1),
    },
  });
});

test('it applies overrides on top of the defaults', () => {
  const resources = buildMockImpResources({ wakeCount: 3, sample: { cpuPercent: 45 } });

  expect(resources).toStrictEqual({
    wakeCount: 3,
    awakeMs: expect.toBeNumber(),
    sample: {
      measuredAt: expect.toBeValidDate(),
      since: expect.toBeValidDate(),
      cpuPercent: 45,
      cpuThrottledMs: expect.toBeNumber(),
      netRxBytes: expect.toBeNumber(),
      netTxBytes: expect.toBeNumber(),
    },
  });
});
