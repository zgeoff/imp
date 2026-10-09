import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeChangedBlocks } from './write-changed-blocks';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'impd-blocks-test-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { source: join(dir, 'source'), target: join(dir, 'target') };
}

test('it writes only the 16 KiB blocks that differ', async () => {
  const ctx = setupTest();
  const before = Buffer.alloc(3 * 1024 ** 2, 7);
  const after = Buffer.from(before);

  after.fill(9, 1024 ** 2 + 100, 1024 ** 2 + 200);

  writeFileSync(ctx.source, after);
  writeFileSync(ctx.target, before);

  const written = await writeChangedBlocks(ctx.source, ctx.target);

  expect(written).toBe(16 * 1024);
  expect(readFileSync(ctx.target)).toStrictEqual(after);
});

test('it fills an empty file and leaves its zero blocks as holes', async () => {
  const ctx = setupTest();
  const sparse = Buffer.alloc(8 * 1024 ** 2);

  sparse.write('head', 0);
  sparse.write('tail', 8 * 1024 ** 2 - 4);

  writeFileSync(ctx.source, sparse);
  writeFileSync(ctx.target, '');

  const written = await writeChangedBlocks(ctx.source, ctx.target);

  expect(written).toBe(2 * 16 * 1024);
  expect(readFileSync(ctx.target)).toStrictEqual(sparse);
  expect(statSync(ctx.target).blocks * 512).toBeLessThan(1024 ** 2);
});

test('it shrinks a target longer than the source', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.source, 'short');
  writeFileSync(ctx.target, Buffer.alloc(1024 ** 2, 1));

  await writeChangedBlocks(ctx.source, ctx.target);

  expect(readFileSync(ctx.target, 'utf8')).toBe('short');
});

test('it closes the source when the target will not open', () => {
  const ctx = setupTest();

  writeFileSync(ctx.source, 'data');

  expect(writeChangedBlocks(ctx.source, ctx.target)).rejects.toThrow('ENOENT');

  // another process lists this one's descriptors that still point at the source
  const open = Bun.spawnSync(['find', `/proc/${String(process.pid)}/fd`, '-lname', ctx.source]);

  expect(open.stdout.toString()).toBe('');
});
