import { expect, test } from 'bun:test';
import { buildMockImpDiskUsage } from './build-mock-imp-disk-usage';
import { buildStubClock } from './build-stub-clock';
import { buildStubSlowMeasure } from './build-stub-slow-measure';

test('it answers the report it was given', async () => {
  const clock = buildStubClock();
  const report = { imps: new Map([['imp-1', buildMockImpDiskUsage()]]), isPartial: true };
  const measureUsage = buildStubSlowMeasure(clock, 4000, report);

  const answered = await measureUsage([{ impId: 'imp-1', checkpointIds: [] }]);

  expect(answered).toBe(report);
});

test('it moves the clock on by its time during each call', async () => {
  const clock = buildStubClock({ startMs: 5000 });
  const measureUsage = buildStubSlowMeasure(clock, 4000, { imps: new Map(), isPartial: false });

  await measureUsage([]);
  await measureUsage([]);

  expect(clock.now()).toBe(13_000);
});
