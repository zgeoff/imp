import { expect, onTestFinished, test } from 'bun:test';
import { linkSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubWideDir } from '../test-utils/build-stub-wide-dir';
import { countTreeBytes } from './count-tree-bytes';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'imp-tree-bytes-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it counts the blocks of every file in the tree, less a 512-byte block each', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.dir, 'etc', 'apt'), { recursive: true });
  writeFileSync(join(ctx.dir, 'motd'), 'x'.repeat(10_000));
  writeFileSync(join(ctx.dir, 'etc', 'apt', 'sources.list'), 'y'.repeat(70_000));

  const motd = statSync(join(ctx.dir, 'motd')).blocks * 512;
  const sources = statSync(join(ctx.dir, 'etc', 'apt', 'sources.list')).blocks * 512;

  expect(motd).toBeGreaterThanOrEqual(10_000);
  expect(sources).toBeGreaterThanOrEqual(70_000);
  expect(countTreeBytes(ctx.dir)).resolves.toBe(motd + sources - 2 * 512);
});

test('it counts an empty file as 0', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.dir, 'empty'), '');

  expect(countTreeBytes(ctx.dir)).resolves.toBe(0);
});

test('it counts a hard-linked file once', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.dir, 'busybox'), 'z'.repeat(50_000));
  linkSync(join(ctx.dir, 'busybox'), join(ctx.dir, 'sh'));

  expect(countTreeBytes(ctx.dir)).resolves.toBe(
    statSync(join(ctx.dir, 'busybox')).blocks * 512 - 512,
  );
});

test('it never counts the target of a symlink', async () => {
  const ctx = await setupTest();
  const outside = await mkdtemp(join(tmpdir(), 'imp-tree-bytes-outside-'));

  onTestFinished(() => rm(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'big'), 'w'.repeat(200_000));
  mkdirSync(join(ctx.dir, 'tree'));
  symlinkSync(join(outside, 'big'), join(ctx.dir, 'tree', 'big'));
  symlinkSync(outside, join(ctx.dir, 'tree', 'elsewhere'));

  expect(countTreeBytes(join(ctx.dir, 'tree'))).resolves.toBe(0);
});

test('it counts a tree with 700,000 sibling directories', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.dir, 'hostname'), 'v'.repeat(20_000));

  const wide = buildStubWideDir(ctx.dir, 700_000);

  expect(countTreeBytes(ctx.dir, { readDir: wide.readDir })).resolves.toBe(
    statSync(join(ctx.dir, 'hostname')).blocks * 512 - 512,
  );
});

test('it counts a tree that does not exist yet as 0', async () => {
  const ctx = await setupTest();

  expect(countTreeBytes(join(ctx.dir, 'root'))).resolves.toBe(0);
});
