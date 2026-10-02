import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeChangedBlocks } from './write-changed-blocks';

const MIB = 1024 * 1024;

function setupTest() {
  const dir = mkdtempSync(`${tmpdir()}/impd-blocks-test-`);

  return {
    source: join(dir, 'source'),
    target: join(dir, 'target'),
    [Symbol.dispose]: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('it writes only the 16 KiB blocks that differ', async () => {
  using ctx = setupTest();

  const before = Buffer.alloc(3 * MIB, 7);
  const after = Buffer.from(before);

  after.fill(9, MIB + 100, MIB + 200);

  writeFileSync(ctx.source, after);
  writeFileSync(ctx.target, before);

  const written = await writeChangedBlocks(ctx.source, ctx.target);

  expect(written).toBe(16 * 1024);
  expect(readFileSync(ctx.target).equals(after)).toBeTrue();
});

test('it fills an empty file, leaves zero blocks as holes, and shrinks a longer one', async () => {
  using ctx = setupTest();

  const sparse = Buffer.alloc(8 * MIB);

  sparse.write('head', 0);
  sparse.write('tail', 8 * MIB - 4);

  writeFileSync(ctx.source, sparse);
  writeFileSync(ctx.target, '');

  const written = await writeChangedBlocks(ctx.source, ctx.target);

  expect(written).toBe(2 * 16 * 1024);
  expect(readFileSync(ctx.target).equals(sparse)).toBeTrue();
  expect(statSync(ctx.target).blocks * 512).toBeLessThan(MIB);

  writeFileSync(ctx.source, 'short');

  await writeChangedBlocks(ctx.source, ctx.target);

  expect(readFileSync(ctx.target, 'utf8')).toBe('short');
});

test('a target that will not open still closes the source', async () => {
  using ctx = setupTest();

  writeFileSync(ctx.source, 'data');

  const failure = await writeChangedBlocks(ctx.source, ctx.target).catch(String);

  const open = readdirSync('/proc/self/fd').map((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      return '';
    }
  });

  expect(failure).toContain('ENOENT');
  expect(open).not.toContain(ctx.source);
});
