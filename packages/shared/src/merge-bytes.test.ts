import { expect, test } from 'bun:test';
import { mergeBytes } from './merge-bytes';

test('it joins the chunks in order', () => {
  expect(
    mergeBytes([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])]),
  ).toStrictEqual(new Uint8Array([1, 2, 3]));
});

test('it gives an empty array for no chunks', () => {
  expect(mergeBytes([])).toStrictEqual(new Uint8Array([]));
});
