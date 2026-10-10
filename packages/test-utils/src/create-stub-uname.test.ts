import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubUname } from './create-stub-uname';

function setupTest() {
  const bin = mkdtempSync(join(tmpdir(), 'stub-uname-'));

  onTestFinished(() => {
    rmSync(bin, { recursive: true, force: true });
  });

  return { bin };
}

test('it prints the system for -s', () => {
  const ctx = setupTest();

  createStubUname({ bin: ctx.bin, system: 'Darwin', machine: 'arm64' });

  expect(Bun.spawnSync([join(ctx.bin, 'uname'), '-s']).stdout.toString()).toBe('Darwin\n');
});

test('it prints the machine for -m', () => {
  const ctx = setupTest();

  createStubUname({ bin: ctx.bin, system: 'Darwin', machine: 'arm64' });

  expect(Bun.spawnSync([join(ctx.bin, 'uname'), '-m']).stdout.toString()).toBe('arm64\n');
});

test('it fails for any other flag', () => {
  const ctx = setupTest();

  createStubUname({ bin: ctx.bin, system: 'Darwin', machine: 'arm64' });

  expect(Bun.spawnSync([join(ctx.bin, 'uname'), '-r']).exitCode).toBe(1);
});
