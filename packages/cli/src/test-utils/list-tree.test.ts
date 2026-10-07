import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listTree } from './list-tree';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dir = await mkdtemp(join(tmpdir(), 'list-tree-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const owned = stack.move();

  return { dir, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it marks directories, symlinks and executable files in sorted order', async () => {
  await using ctx = await setupTest();

  await mkdir(join(ctx.dir, 'sub'));
  await writeFile(join(ctx.dir, 'sub', 'b.txt'), '');
  await writeFile(join(ctx.dir, 'run'), '');
  await chmod(join(ctx.dir, 'run'), 0o755);
  await symlink('run', join(ctx.dir, 'start'));

  const tree = await listTree(ctx.dir);

  expect(tree).toStrictEqual(['run*', 'start@', 'sub/', 'sub/b.txt']);
});

test('it lists nothing for an empty directory', async () => {
  await using ctx = await setupTest();

  const tree = await listTree(ctx.dir);

  expect(tree).toStrictEqual([]);
});
