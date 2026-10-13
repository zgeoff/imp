import { expect, test } from 'bun:test';
import { formatMib } from './format-mib';

test.each([
  [300, '300 MiB'],
  [2048, '2.0 GiB'],
  [6 * 1024 * 1024, '6.0 TiB'],
])('it formats %d MiB as %s', (mib, expected) => {
  expect(formatMib(mib)).toBe(expected);
});
