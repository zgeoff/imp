import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubShasum } from './create-stub-shasum';
import { updateEnv } from './update-env';

function setupTest() {
  using stack = new DisposableStack();

  const bin = mkdtempSync(join(tmpdir(), 'stub-shasum-'));

  stack.defer(() => {
    rmSync(bin, { recursive: true, force: true });
  });

  const owned = stack.move();

  return {
    bin,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it prints the SHA-256 and the name of a file for -a 256', () => {
  using ctx = setupTest();

  const file = join(ctx.bin, 'payload');

  writeFileSync(file, 'hello');
  createStubShasum({ bin: ctx.bin });

  const run = Bun.spawnSync([join(ctx.bin, 'shasum'), '-a', '256', file]);

  expect(run.stdout.toString()).toBe(
    `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  ${file}\n`,
  );
});

test('it fails for an algorithm other than 256', () => {
  using ctx = setupTest();

  createStubShasum({ bin: ctx.bin });

  expect(Bun.spawnSync([join(ctx.bin, 'shasum'), '-a', '1', 'payload']).exitCode).toBe(1);
});

test('it records the arguments of each call in order', () => {
  using ctx = setupTest();

  const shasum = createStubShasum({ bin: ctx.bin });

  Bun.spawnSync([join(ctx.bin, 'shasum'), '-a', '1', 'first']);
  Bun.spawnSync([join(ctx.bin, 'shasum'), '-a', '1', 'second']);

  expect(shasum.readCalls()).toStrictEqual(['-a 1 first', '-a 1 second']);
});

test('it rejects a machine without sha256sum on PATH', () => {
  using ctx = setupTest();

  updateEnv('PATH', ctx.bin);

  expect(() => {
    createStubShasum({ bin: ctx.bin });
  }).toThrowWithMessage(Error, 'sha256sum is not on PATH');
});
