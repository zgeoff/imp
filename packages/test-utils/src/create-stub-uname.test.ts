import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubUname } from './create-stub-uname';

function setupTest() {
  using stack = new DisposableStack();

  const bin = mkdtempSync(join(tmpdir(), 'stub-uname-'));

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

test('it prints the system for -s', () => {
  using ctx = setupTest();

  createStubUname({ bin: ctx.bin, system: 'Darwin', machine: 'arm64' });

  expect(Bun.spawnSync([join(ctx.bin, 'uname'), '-s']).stdout.toString()).toBe('Darwin\n');
});

test('it prints the machine for -m', () => {
  using ctx = setupTest();

  createStubUname({ bin: ctx.bin, system: 'Darwin', machine: 'arm64' });

  expect(Bun.spawnSync([join(ctx.bin, 'uname'), '-m']).stdout.toString()).toBe('arm64\n');
});

test('it fails for any other flag', () => {
  using ctx = setupTest();

  createStubUname({ bin: ctx.bin, system: 'Darwin', machine: 'arm64' });

  expect(Bun.spawnSync([join(ctx.bin, 'uname'), '-r']).exitCode).toBe(1);
});
