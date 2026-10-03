import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeImageConfig } from './write-image-config';

const CONFIG = '{"env":["A=1"]}';
let base = '';
let root = '';
let outside = '';

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'imp-image-config-'));
  root = join(base, 'root');
  outside = join(base, 'outside');

  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, 'token'), 'secret');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function readConfig(): string {
  return readFileSync(join(root, 'etc', 'imp', 'image.json'), 'utf8');
}

// what writeImageConfig threw, or null
function readWriteFailure(): unknown {
  try {
    writeImageConfig(root, CONFIG);
  } catch (error) {
    return error;
  }

  return null;
}

test('it makes etc/imp and the file in a tree that has neither', () => {
  writeImageConfig(root, CONFIG);

  expect(readConfig()).toBe(CONFIG);
});

test("it replaces the image's own image.json", () => {
  mkdirSync(join(root, 'etc', 'imp'), { recursive: true });
  writeFileSync(join(root, 'etc', 'imp', 'image.json'), '{"old":true}');
  writeImageConfig(root, CONFIG);

  expect(readConfig()).toBe(CONFIG);
});

test('an image.json that links out of the tree is replaced, and its target is left alone', () => {
  mkdirSync(join(root, 'etc', 'imp'), { recursive: true });
  symlinkSync(join(outside, 'token'), join(root, 'etc', 'imp', 'image.json'));
  writeImageConfig(root, CONFIG);

  expect(lstatSync(join(root, 'etc', 'imp', 'image.json')).isFile()).toBe(true);
  expect(readConfig()).toBe(CONFIG);
  expect(readFileSync(join(outside, 'token'), 'utf8')).toBe('secret');
});

test('an image.json that links to a missing file out of the tree creates nothing there', () => {
  mkdirSync(join(root, 'etc', 'imp'), { recursive: true });
  symlinkSync(join(outside, 'new'), join(root, 'etc', 'imp', 'image.json'));
  writeImageConfig(root, CONFIG);

  expect(readConfig()).toBe(CONFIG);
  expect(existsSync(join(outside, 'new'))).toBe(false);
});

test('an etc that links out of the tree refuses the image and writes nothing there', () => {
  symlinkSync(outside, join(root, 'etc'));

  const failure = readWriteFailure();

  expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
  expect(String(failure)).toContain("the image's /etc is a symlink");
  expect(existsSync(join(outside, 'imp'))).toBe(false);
});

test('an etc/imp that links out of the tree, by a relative path, refuses the image', () => {
  mkdirSync(join(root, 'etc'));
  symlinkSync('../../outside', join(root, 'etc', 'imp'));

  const failure = readWriteFailure();

  expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
  expect(String(failure)).toContain("the image's /etc/imp is a symlink");
  expect(existsSync(join(outside, 'image.json'))).toBe(false);
  expect(readFileSync(join(outside, 'token'), 'utf8')).toBe('secret');
});

test('an etc that is a file refuses the image', () => {
  writeFileSync(join(root, 'etc'), '');

  expect(String(readWriteFailure())).toContain("the image's /etc is not a directory");
});
