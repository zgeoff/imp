import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernelOopsWatch } from './kernel-oops-watch';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-taint-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // where the test writes the kernel's taint mask, as /proc/sys/kernel/tainted
  return { taintPath: join(dir, 'tainted') };
}

test('it reads a clear taint mask as no oops', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, '0\n');

  expect(createKernelOopsWatch(ctx.taintPath).isOopsed()).toBeFalse();
});

test('it reads taint flag D as an oops', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, '128\n');

  expect(createKernelOopsWatch(ctx.taintPath).isOopsed()).toBeTrue();
});

test('it reads flag D among other taint flags as an oops', () => {
  const ctx = setupTest();

  // D with O (an out-of-tree module, as zfs is) and E (unsigned)
  writeFileSync(ctx.taintPath, `${String(128 + 4096 + 8192)}\n`);

  expect(createKernelOopsWatch(ctx.taintPath).isOopsed()).toBeTrue();
});

test('it reads other taint flags without D as no oops', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, `${String(4096 + 8192)}\n`);

  expect(createKernelOopsWatch(ctx.taintPath).isOopsed()).toBeFalse();
});

test('it reads a missing taint file as no oops', () => {
  const ctx = setupTest();

  expect(createKernelOopsWatch(ctx.taintPath).isOopsed()).toBeFalse();
});

test('it reads a malformed taint file as no oops', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, 'tainted\n');

  expect(createKernelOopsWatch(ctx.taintPath).isOopsed()).toBeFalse();
});

test('it reads the flag clear from a taint mask without D', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, `${String(4096)}\n`);

  expect(createKernelOopsWatch(ctx.taintPath).readFlag()).toBe('clear');
});

test('it reads the flag set from a taint mask with D', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, `${String(128 + 4096)}\n`);

  expect(createKernelOopsWatch(ctx.taintPath).readFlag()).toBe('set');
});

test('it reads the flag unknown from a missing taint file', () => {
  const ctx = setupTest();

  expect(createKernelOopsWatch(ctx.taintPath).readFlag()).toBe('unknown');
});

test('it reads the flag unknown from a taint file it cannot read', () => {
  const ctx = setupTest();

  // a directory where the file should be: the read fails with EISDIR
  mkdirSync(ctx.taintPath);

  expect(createKernelOopsWatch(ctx.taintPath).readFlag()).toBe('unknown');
});

test('it reads the flag unknown from a malformed taint file', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, 'tainted\n');

  expect(createKernelOopsWatch(ctx.taintPath).readFlag()).toBe('unknown');
});

test('it reads the flag clear once the file reads clear after an unknown read', () => {
  const ctx = setupTest();
  const watch = createKernelOopsWatch(ctx.taintPath);

  watch.readFlag();

  writeFileSync(ctx.taintPath, '0\n');

  expect(watch.readFlag()).toBe('clear');
});

test('it finds when it first read the flag set after it read the flag clear', () => {
  const ctx = setupTest();
  const clock = { nowMs: 1000 };

  writeFileSync(ctx.taintPath, '0\n');

  const watch = createKernelOopsWatch(ctx.taintPath, () => clock.nowMs);

  watch.isOopsed();

  writeFileSync(ctx.taintPath, '128\n');

  clock.nowMs = 2000;

  watch.isOopsed();

  clock.nowMs = 3000;

  expect(watch.findOopsSeenAt()).toBe(2000);
});

test('it finds no oops since clear when the flag was set at the first read', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, '128\n');

  const watch = createKernelOopsWatch(ctx.taintPath);

  watch.isOopsed();

  expect(watch.findOopsSeenAt()).toBeNull();
});

test('it finds no oops since clear while the flag stays clear', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, '0\n');

  const watch = createKernelOopsWatch(ctx.taintPath);

  watch.isOopsed();

  expect(watch.findOopsSeenAt()).toBeNull();
});

test('it keeps an oops it saw once the file reads clear again', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, '128\n');

  const watch = createKernelOopsWatch(ctx.taintPath);

  watch.isOopsed();

  // the kernel never clears D; a read that says so is not a reboot
  writeFileSync(ctx.taintPath, '0\n');

  expect(watch.isOopsed()).toBeTrue();
});
