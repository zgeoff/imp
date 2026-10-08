import { expect, onTestFinished, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listTree } from './list-tree';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'list-tree-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it marks directories, symlinks and executable files in sorted order', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dir, 'sub'));
  await writeFile(join(ctx.dir, 'sub', 'b.txt'), '');
  await writeFile(join(ctx.dir, 'run'), '');
  await chmod(join(ctx.dir, 'run'), 0o755);
  await symlink('run', join(ctx.dir, 'start'));

  const tree = await listTree(ctx.dir);

  expect(tree).toStrictEqual(['run*', 'start@', 'sub/', 'sub/b.txt']);
});

test('it lists nothing for an empty directory', async () => {
  const ctx = await setupTest();
  const tree = await listTree(ctx.dir);

  expect(tree).toStrictEqual([]);
});
