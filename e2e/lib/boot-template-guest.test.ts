import { expect, test } from 'bun:test';
import { checkNoShapeTemplate, parseTemplateKeys } from './boot-template-guest';

test('#checkNoShapeTemplate passes when no template of the size is there', () => {
  expect(() => {
    checkNoShapeTemplate(288, []);
  }).not.toThrow();
});

test('#checkNoShapeTemplate throws, naming --keep, when a template of the size is there', () => {
  expect(() => {
    checkNoShapeTemplate(288, ['0e61ca281a1c9f']);
  }).toThrowWithMessage(
    Error,
    'a boot template of 288 MiB is already there (0e61ca281a1c9f); a run with --keep leaves one, so remove it first',
  );
});

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
