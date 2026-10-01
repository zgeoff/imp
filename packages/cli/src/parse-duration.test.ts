import { expect, test } from 'bun:test';
import { parseDuration } from './parse-duration';

test('it reads bare seconds and each unit', () => {
  expect(parseDuration('90')).toBe(90);
  expect(parseDuration('90s')).toBe(90);
  expect(parseDuration('15m')).toBe(900);
  expect(parseDuration('2h')).toBe(7200);
  expect(parseDuration('1d')).toBe(86_400);
  expect(parseDuration('0')).toBe(0);
});

test('it rejects anything else', () => {
  for (const text of ['', 'h', '1.5h', '-1', '10w', '1h30m']) {
    expect(() => parseDuration(text)).toThrow('not a duration');
  }
});
