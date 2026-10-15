import { expect, test } from 'bun:test';
import { parseDuCount } from './create-image-writer';

test('#parseDuCount reads the count du prints before its path', () => {
  expect(parseDuCount('4096\t/data/root\n')).toBe(4096);
});

test('#parseDuCount refuses du output that does not start with a count', () => {
  expect(() => parseDuCount('du: cannot access')).toThrowWithMessage(
    TypeError,
    'du printed du: cannot access',
  );
});
