import type { DiskUsageReport, StorageBackend } from '../storage/storage-backend';

// A storage backend's `measureUsage` that takes `ms` of the test's clock, as a
// slow XFS measure does: each call moves `clock` on by `ms`, then answers
// `report`.
export function buildStubSlowMeasure(
  clock: Readonly<{ runFor: (ms: number) => void }>,
  ms: number,
  report: DiskUsageReport,
): StorageBackend['measureUsage'] {
  return () => {
    clock.runFor(ms);

    return Promise.resolve(report);
  };
}
