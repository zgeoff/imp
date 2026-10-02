import { expect, test } from 'bun:test';
import { parseUtcTime } from './backup';

test('--at reads a time without a zone as UTC, never local time', () => {
  expect(parseUtcTime('2026-10-02T06:00').toISOString()).toBe('2026-10-02T06:00:00.000Z');
  expect(parseUtcTime('2026-10-02').toISOString()).toBe('2026-10-02T00:00:00.000Z');
  expect(parseUtcTime('2026-10-02T16:00+10:00').toISOString()).toBe('2026-10-02T06:00:00.000Z');
  expect(() => parseUtcTime('yesterday')).toThrow('--at takes a time such as');
});
