import { expect, test } from 'bun:test';
import { parseTemplateKeys } from './boot-template-guest';

test('#parseTemplateKeys reads the key of each meta.json grep lists', () => {
  const listing = [
    '/var/lib/imp/templates/0e61ca281a1c9f/meta.json',
    '/var/lib/imp/templates/7a2b44c0d1e3aa/meta.json',
    '',
  ].join('\n');

  expect(parseTemplateKeys(listing)).toStrictEqual(['0e61ca281a1c9f', '7a2b44c0d1e3aa']);
});

test('#parseTemplateKeys reads no keys from empty output', () => {
  expect(parseTemplateKeys('')).toStrictEqual([]);
});
