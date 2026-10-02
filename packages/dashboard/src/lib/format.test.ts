import { expect, test } from 'bun:test';
import { formatBytes, formatMib, formatRelativeTime } from './format';

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
