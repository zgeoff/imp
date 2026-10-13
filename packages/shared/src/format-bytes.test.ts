import { expect, test } from 'bun:test';
import { formatBytes } from './format-bytes';

test.each([
  [0, '0 B'],
  [512, '512 B'],
  [1536, '1.5 KiB'],
  [300 * 1024 * 1024, '300 MiB'],
  [2 * 1024 ** 3, '2.0 GiB'],
  [2048 * 1024 ** 4, '2048 TiB'],
])('it formats %d bytes as %s', (bytes, expected) => {
  expect(formatBytes(bytes)).toBe(expected);
});
