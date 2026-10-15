import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateReadOnly } from './update-read-only';

function setupTest() {
  const stack = new DisposableStack();

  onTestFinished(() => {
    stack.dispose();
  });

  const dir = mkdtempSync(join(tmpdir(), 'update-read-only-'));

  stack.defer(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { stack, dir };
}

test('it refuses a new file anywhere in the tree', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'tree', 'inner'), { recursive: true });
  updateReadOnly(ctx.stack, join(ctx.dir, 'tree'));

  expect(() => {
    writeFileSync(join(ctx.dir, 'tree', 'inner', 'new'), 'x');
  }).toThrow(expect.objectContaining({ code: expect.toBeOneOf(['EACCES', 'EPERM']) }));
});

test('it keeps the files in the tree readable', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'tree'));
  writeFileSync(join(ctx.dir, 'tree', 'kept'), 'kept\n');
  updateReadOnly(ctx.stack, join(ctx.dir, 'tree'));

  expect(readFileSync(join(ctx.dir, 'tree', 'kept'), 'utf8')).toBe('kept\n');
});

test('it makes the tree writable again on restore', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'tree'));

  const restore = updateReadOnly(ctx.stack, join(ctx.dir, 'tree'));

  restore();
  writeFileSync(join(ctx.dir, 'tree', 'new'), 'x');

  expect(readFileSync(join(ctx.dir, 'tree', 'new'), 'utf8')).toBe('x');
});

test('it makes the tree writable again when the stack is released', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'tree'));

  const stack = new DisposableStack();

  // released by the test's own stack too, before the directory goes, should
  // the test fail first
  ctx.stack.defer(() => {
    stack.dispose();
  });

  updateReadOnly(stack, join(ctx.dir, 'tree'));

  stack.dispose();

  writeFileSync(join(ctx.dir, 'tree', 'new'), 'x');

  expect(readFileSync(join(ctx.dir, 'tree', 'new'), 'utf8')).toBe('x');
});

test('it passes over a tree removed before the stack is released', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.dir, 'tree'));

  const stack = new DisposableStack();

  const restore = updateReadOnly(stack, join(ctx.dir, 'tree'));

  restore();
  rmSync(join(ctx.dir, 'tree'), { recursive: true });

  expect(() => {
    stack.dispose();
  }).not.toThrow();
});
