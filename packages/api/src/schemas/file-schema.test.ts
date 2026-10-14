import { expect, test } from 'bun:test';
import { FILE_DATA_MAX_BYTES, FileContentSchema, FilePathSchema } from './file-schema';

test.each([
  'today.json',
  '_.json',
  'a/b/c/d/e/f/g/h',
  'records/0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30.json',
  'a'.repeat(128),
])('#FilePathSchema accepts the path %s', (path) => {
  expect(FilePathSchema.safeParse(path).data).toBe(path);
});

test.each([
  '/notes/today.json',
  'notes//today.json',
  'notes/',
  '../today.json',
  'notes/../today.json',
  './today.json',
  '.today.json',
  'no spaces.json',
  'a/b/c/d/e/f/g/h/i',
  'a'.repeat(129),
])('#FilePathSchema rejects the path %p', (path) => {
  const result = FilePathSchema.safeParse(path);

  expect(result.error?.issues).toPartiallyContain({
    path: [],
    message:
      'must be 1 to 8 segments joined by /, each a letter, digit or _ followed by up to 127 letters, digits, ., _ or -',
  });
});

test('#FilePathSchema rejects an empty path', () => {
  const result = FilePathSchema.safeParse('');

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'too_small' });
});

test('#FilePathSchema rejects a path over 512 bytes', () => {
  const result = FilePathSchema.safeParse(`${'abcdefg/'.repeat(64)}x`);

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'too_big' });
});

test('#FileContentSchema accepts content at the cap', () => {
  const content = 'a'.repeat(FILE_DATA_MAX_BYTES);

  expect(FileContentSchema.safeParse(content).data).toBe(content);
});

test('#FileContentSchema counts the cap in UTF-8 bytes, not characters', () => {
  const result = FileContentSchema.safeParse('é'.repeat(FILE_DATA_MAX_BYTES / 2 + 1));

  expect(result.error?.issues).toPartiallyContain({
    path: [],
    message: 'must be at most 524288 bytes as UTF-8',
  });
});
