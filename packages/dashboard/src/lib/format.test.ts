import { expect, test } from 'bun:test';
import { buildImp } from '../test-utils/fake-impd';
import {
  formatBytes,
  formatCpuUse,
  formatDiskUse,
  formatDuration,
  formatMib,
  formatRelativeTime,
} from './format';

test('it formats sizes in binary units', () => {
  expect(formatBytes(512)).toBe('512 B');
  expect(formatBytes(1536)).toBe('1.5 KiB');
  expect(formatMib(300)).toBe('300 MiB');
  expect(formatMib(2048)).toBe('2.0 GiB');
  expect(formatMib(6 * 1024 * 1024)).toBe('6.0 TiB');
});

test('it formats times relative to now, past and future', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');

  expect(formatRelativeTime(new Date(now - 12_000), now)).toBe('12s ago');
  expect(formatRelativeTime(new Date(now - 3 * 3_600_000), now)).toBe('3h ago');
  expect(formatRelativeTime(new Date(now - 2 * 86_400_000), now)).toBe('2d ago');
  expect(formatRelativeTime(new Date(now + 90_000), now)).toBe('in 1m');
});

test('it formats CPU use over the limit', () => {
  const sample = {
    measuredAt: new Date(),
    since: new Date(),
    cpuPercent: 44.6,
    cpuThrottledMs: 0,
    netRxBytes: 0,
    netTxBytes: 0,
  };

  const resources = { wakeCount: 1, awakeMs: 0, sample };

  expect(formatCpuUse(buildImp({ name: 'a' }))).toBe('—');
  expect(formatCpuUse(buildImp({ name: 'a', resources }))).toBe('45%');

  expect(formatCpuUse(buildImp({ name: 'a', resources, cpu: { limit: 1.5, weight: 100 } }))).toBe(
    '45% / 1.5',
  );
});

test('it formats durations', () => {
  expect(formatDuration(45_000)).toBe('45s');
  expect(formatDuration(12 * 60_000)).toBe('12m');
  expect(formatDuration(200 * 60_000)).toBe('3h 20m');
});

test('it formats disk use over the disk size, with its markers', () => {
  const usage = {
    exclusiveBytes: 1536 * 1024 * 1024,
    sharedBytes: 0,
    measuredAt: new Date(),
    isPartial: false,
    isUpperBound: false,
  };

  expect(formatDiskUse(buildImp({ name: 'a', diskMib: 32_768 }))).toBe('— / 32.0 GiB');

  expect(formatDiskUse(buildImp({ name: 'a', diskMib: 32_768, diskUsage: usage }))).toBe(
    '1.5 GiB / 32.0 GiB',
  );

  expect(
    formatDiskUse(
      buildImp({
        name: 'a',
        diskMib: 32_768,
        diskUsage: { ...usage, isPartial: true, isUpperBound: true },
      }),
    ),
  ).toBe('≤1.5 GiB? / 32.0 GiB');
});
