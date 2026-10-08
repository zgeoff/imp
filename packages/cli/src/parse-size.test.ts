import { expect, test } from 'bun:test';
import { parseCount, parseSize } from './parse-size';
import { UsageError } from './usage-error';

test.each([
  ['2048', 2048],
  ['512m', 512],
  ['2g', 2048],
  ['2G', 2048],
  ['2GiB', 2048],
  ['256MB', 256],
  ['1t', 1_048_576],
])('#parseSize reads %p as %p MiB', (text, mib) => {
  expect(parseSize(text)).toBe(mib);
});

test.each(['1.5g', '0', '0g', '', 'g', '2k', '-1', 'lots', '512b', '512ib', '2gb2'])(
  '#parseSize rejects %p as a usage error',
  (text) => {
    expect(() => parseSize(text)).toThrowWithMessage(
      UsageError,
      `not a size: ${text} (try 512m, 2g, 1t, or MiB as a whole number)`,
    );
  },
);

test('#parseCount reads a whole number above zero', () => {
  expect(parseCount('4', 'cpus')).toBe(4);
});

test.each(['0', '1.5', '', 'two', '-1'])('#parseCount rejects %p as a usage error', (text) => {
  expect(() => parseCount(text, 'cpus')).toThrowWithMessage(
    UsageError,
    `--cpus needs a whole number above 0, not ${text}`,
  );
});
