import { expect, test } from 'bun:test';
import { buildMockDiskUsage } from '../test-utils/build-mock-disk-usage';
import { buildMockImp } from '../test-utils/build-mock-imp';
import { buildMockImpResources } from '../test-utils/build-mock-imp-resources';
import {
  formatBytes,
  formatCpuUse,
  formatDiskUse,
  formatDuration,
  formatMib,
  formatRelativeTime,
} from './format';

test.each([
  [512, '512 B'],
  [1536, '1.5 KiB'],
  [300 * 1024 * 1024, '300 MiB'],
])('#formatBytes formats %d bytes as %s', (bytes, expected) => {
  expect(formatBytes(bytes)).toBe(expected);
});

test.each([
  [300, '300 MiB'],
  [2048, '2.0 GiB'],
  [6 * 1024 * 1024, '6.0 TiB'],
])('#formatMib formats %d MiB as %s', (mib, expected) => {
  expect(formatMib(mib)).toBe(expected);
});

test.each([
  [-12_000, '12s ago'],
  [-3 * 3_600_000, '3h ago'],
  [-2 * 86_400_000, '2d ago'],
  [90_000, 'in 1m'],
])('#formatRelativeTime reads a time %d ms from now as %s', (offsetMs, expected) => {
  const now = Date.parse('2026-10-02T12:00:00Z');

  expect(formatRelativeTime(new Date(now + offsetMs), now)).toBe(expected);
});

test.each([
  [45_000, '45s'],
  [12 * 60_000, '12m'],
  [200 * 60_000, '3h 20m'],
])('#formatDuration formats %d ms as %s', (ms, expected) => {
  expect(formatDuration(ms)).toBe(expected);
});

test('#formatCpuUse shows a dash for an imp with no sample', () => {
  expect(formatCpuUse(buildMockImp())).toBe('—');
});

test('#formatCpuUse rounds the sampled CPU of an imp without a limit', () => {
  const imp = buildMockImp({ resources: buildMockImpResources({ sample: { cpuPercent: 44.6 } }) });

  expect(formatCpuUse(imp)).toBe('45%');
});

test('#formatCpuUse shows the sampled CPU over the limit', () => {
  const imp = buildMockImp({
    resources: buildMockImpResources({ sample: { cpuPercent: 44.6 } }),
    cpu: { limit: 1.5, weight: 100 },
  });

  expect(formatCpuUse(imp)).toBe('45% / 1.5');
});

test('#formatDiskUse shows a dash over the disk size before a measurement', () => {
  expect(formatDiskUse(buildMockImp({ diskMib: 32_768 }))).toBe('— / 32.0 GiB');
});

test('#formatDiskUse shows the exclusive use over the disk size', () => {
  const imp = buildMockImp({
    diskMib: 32_768,
    diskUsage: buildMockDiskUsage({
      exclusiveBytes: 1536 * 1024 * 1024,
      isPartial: false,
      isUpperBound: false,
    }),
  });

  expect(formatDiskUse(imp)).toBe('1.5 GiB / 32.0 GiB');
});

test('#formatDiskUse marks a use that is an upper bound from a partial pass', () => {
  const imp = buildMockImp({
    diskMib: 32_768,
    diskUsage: buildMockDiskUsage({
      exclusiveBytes: 1536 * 1024 * 1024,
      isPartial: true,
      isUpperBound: true,
    }),
  });

  expect(formatDiskUse(imp)).toBe('≤1.5 GiB? / 32.0 GiB');
});
