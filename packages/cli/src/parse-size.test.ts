import { expect, test } from 'bun:test';
import { parseCount, parseSize } from './parse-size';

test('it reads sizes as MiB', () => {
  expect(parseSize('2048')).toBe(2048);
  expect(parseSize('512m')).toBe(512);
  expect(parseSize('2g')).toBe(2048);
  expect(parseSize('2G')).toBe(2048);
  expect(parseSize('2GiB')).toBe(2048);
  expect(parseSize('256MB')).toBe(256);
});

test('it rejects fractions, zero and other units', () => {
  for (const text of ['1.5g', '0', '0g', '', 'g', '2t', '-1', 'lots']) {
    expect(() => parseSize(text)).toThrow(`not a size: ${text}`);
  }
});

test('it reads counts and rejects anything but a whole number above zero', () => {
  expect(parseCount('4', 'cpus')).toBe(4);

  for (const text of ['0', '1.5', '', 'two', '-1']) {
    expect(() => parseCount(text, 'cpus')).toThrow(
      `--cpus needs a whole number above 0, not ${text}`,
    );
  }
});
