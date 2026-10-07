import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubTree } from './create-stub-tree';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const root = await mkdtemp(join(tmpdir(), 'imp-stub-tree-'));

  stack.defer(() => rm(root, { recursive: true, force: true }));

  const owned = stack.move();

  return { root, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it writes each file under the root with its directories', async () => {
  await using ctx = await setupTest();

  await createStubTree(ctx.root, { 'a.txt': 'a', 'deep/er/b.txt': 'b' });

  const listed = await readdir(ctx.root, { recursive: true });
  const nested = await readFile(join(ctx.root, 'deep/er/b.txt'), 'utf8');

  expect(listed).toIncludeSameMembers(['a.txt', 'deep', 'deep/er', 'deep/er/b.txt']);
  expect(nested).toBe('b');
});

test('it writes an empty file for empty text', async () => {
  await using ctx = await setupTest();

  await createStubTree(ctx.root, { empty: '' });

  const written = await readFile(join(ctx.root, 'empty'), 'utf8');

  expect(written).toBe('');
});
