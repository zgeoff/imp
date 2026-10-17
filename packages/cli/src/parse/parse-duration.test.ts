import { expect, test } from 'bun:test';
import { parseDuration } from './parse-duration';

test.each([
  ['90', 90],
  ['90s', 90],
  ['15m', 900],
  ['2h', 7200],
  ['1d', 86_400],
  ['0', 0],
])('it reads %p as %p seconds', (text, seconds) => {
  expect(parseDuration(text)).toBe(seconds);
});

test.each(['', 'h', '1.5h', '-1', '10w', '1h30m'])('it rejects %p as not a duration', (text) => {
  expect(() => parseDuration(text)).toThrowWithMessage(
    Error,
    `not a duration: ${text} (try 90s, 15m, 2h)`,
  );
});
