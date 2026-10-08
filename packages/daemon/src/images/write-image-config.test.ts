import { expect, onTestFinished, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeImageConfig } from './write-image-config';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const base = await mkdtemp(join(tmpdir(), 'imp-image-config-'));

  stack.defer(() => rm(base, { recursive: true, force: true }));

  const root = join(base, 'root');
  const outside = join(base, 'outside');

  // the unpacked tree, and a directory beside it a link could reach
  mkdirSync(root);
  mkdirSync(outside);

  return { root, outside };
}

test('it makes etc/imp and the file in a tree that has neither', async () => {
  const ctx = await setupTest();

  writeImageConfig(ctx.root, '{"env":["A=1"]}');

  expect(readFileSync(join(ctx.root, 'etc', 'imp', 'image.json'), 'utf8')).toBe('{"env":["A=1"]}');
});

test("it replaces the image's own image.json", async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.root, 'etc', 'imp'), { recursive: true });
  writeFileSync(join(ctx.root, 'etc', 'imp', 'image.json'), '{"old":true}');
  writeImageConfig(ctx.root, '{"env":["A=1"]}');

  expect(readFileSync(join(ctx.root, 'etc', 'imp', 'image.json'), 'utf8')).toBe('{"env":["A=1"]}');
});

test('it replaces an image.json that links out of the tree with a file', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.root, 'etc', 'imp'), { recursive: true });
  writeFileSync(join(ctx.outside, 'token'), 'secret');
  symlinkSync(join(ctx.outside, 'token'), join(ctx.root, 'etc', 'imp', 'image.json'));
  writeImageConfig(ctx.root, '{"env":["A=1"]}');

  expect(lstatSync(join(ctx.root, 'etc', 'imp', 'image.json')).isFile()).toBeTrue();
});

test('it never writes the target of an image.json that links out of the tree', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.root, 'etc', 'imp'), { recursive: true });
  writeFileSync(join(ctx.outside, 'token'), 'secret');
  symlinkSync(join(ctx.outside, 'token'), join(ctx.root, 'etc', 'imp', 'image.json'));
  writeImageConfig(ctx.root, '{"env":["A=1"]}');

  expect(readFileSync(join(ctx.outside, 'token'), 'utf8')).toBe('secret');
});

test('it creates nothing out of the tree for an image.json linking to a missing file', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.root, 'etc', 'imp'), { recursive: true });
  symlinkSync(join(ctx.outside, 'new'), join(ctx.root, 'etc', 'imp', 'image.json'));
  writeImageConfig(ctx.root, '{"env":["A=1"]}');

  expect(existsSync(join(ctx.outside, 'new'))).toBeFalse();
});

test('it refuses an image whose etc links out of the tree', async () => {
  const ctx = await setupTest();

  symlinkSync(ctx.outside, join(ctx.root, 'etc'));

  expect(() => {
    writeImageConfig(ctx.root, '{"env":["A=1"]}');
  }).toThrow(
    expect.objectContaining({
      code: 'BAD_REQUEST',
      message:
        "the image's /etc is a symlink; impd writes /etc/imp/image.json there, so it must be a directory",
    }),
  );
});

test('it writes nothing out of the tree when etc links out of it', async () => {
  const ctx = await setupTest();

  symlinkSync(ctx.outside, join(ctx.root, 'etc'));

  expect(() => {
    writeImageConfig(ctx.root, '{"env":["A=1"]}');
  }).toThrow();

  expect(existsSync(join(ctx.outside, 'imp'))).toBeFalse();
});

test('it refuses an image whose etc/imp links out of the tree by a relative path', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.root, 'etc'));
  symlinkSync('../../outside', join(ctx.root, 'etc', 'imp'));

  expect(() => {
    writeImageConfig(ctx.root, '{"env":["A=1"]}');
  }).toThrow(
    expect.objectContaining({
      code: 'BAD_REQUEST',
      message:
        "the image's /etc/imp is a symlink; impd writes /etc/imp/image.json there, so it must be a directory",
    }),
  );
});

test('it refuses an image whose etc is a file', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.root, 'etc'), '');

  expect(() => {
    writeImageConfig(ctx.root, '{"env":["A=1"]}');
  }).toThrow(
    expect.objectContaining({
      code: 'BAD_REQUEST',
      message:
        "the image's /etc is not a directory; impd writes /etc/imp/image.json there, so it must be a directory",
    }),
  );
});
