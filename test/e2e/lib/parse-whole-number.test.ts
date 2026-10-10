import { expect, test } from 'bun:test';
import { parseWholeNumber } from './parse-whole-number';

test('#parseWholeNumber reads a number a command printed with its newline', () => {
  expect(parseWholeNumber('4096\n', 'MemTotal')).toBe(4096);
});

test('#parseWholeNumber throws on empty output', () => {
  expect(() => parseWholeNumber('', 'MemTotal')).toThrowWithMessage(
    Error,
    'MemTotal: not a whole number: ""',
  );
});

test('#parseWholeNumber throws on output that is not a whole number', () => {
  expect(() => parseWholeNumber('12 kB', 'MemTotal')).toThrowWithMessage(
    Error,
    'MemTotal: not a whole number: "12 kB"',
  );
});
