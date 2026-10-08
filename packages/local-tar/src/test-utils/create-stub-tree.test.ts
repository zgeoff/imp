import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubTree } from './create-stub-tree';

async function setupTest() {
  const root = await mkdtemp(join(tmpdir(), 'imp-stub-tree-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  return { root };
}

test('it writes each file under the root with its directories', async () => {
  const ctx = await setupTest();

  await createStubTree(ctx.root, { 'a.txt': 'a', 'deep/er/b.txt': 'b' });

  const listed = await readdir(ctx.root, { recursive: true });
  const nested = await readFile(join(ctx.root, 'deep/er/b.txt'), 'utf8');

  expect(listed).toIncludeSameMembers(['a.txt', 'deep', 'deep/er', 'deep/er/b.txt']);
  expect(nested).toBe('b');
});

test('it writes an empty file for empty text', async () => {
  const ctx = await setupTest();

  await createStubTree(ctx.root, { empty: '' });

  const written = await readFile(join(ctx.root, 'empty'), 'utf8');

  expect(written).toBe('');
});
