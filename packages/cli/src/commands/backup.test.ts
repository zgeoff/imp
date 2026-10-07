import { expect, test } from 'bun:test';
import { UsageError } from '../usage-error';
import { parseUtcTime } from './backup';

test.each([
  ['2026-10-02T06:00', '2026-10-02T06:00:00.000Z'],
  ['2026-10-02', '2026-10-02T00:00:00.000Z'],
  ['2026-10-02T16:00+10:00', '2026-10-02T06:00:00.000Z'],
])('it reads %p as the UTC time %p, never local time', (text, iso) => {
  expect(parseUtcTime(text)).toStrictEqual(new Date(iso));
});

test('it rejects text that is no time as a usage error', () => {
  expect(() => parseUtcTime('yesterday')).toThrowWithMessage(
    UsageError,
    '--at takes a time such as 2026-10-02T06:00Z, not yesterday',
  );
});
