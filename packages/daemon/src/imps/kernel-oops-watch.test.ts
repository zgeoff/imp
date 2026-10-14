import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('it finds an oops since clear once the flag goes from clear to set', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, '0\n');

  const watch = createKernelOopsWatch(ctx.taintPath);

  watch.isOopsed();

  writeFileSync(ctx.taintPath, '128\n');

  expect(watch.hasOopsedSinceClear()).toBeTrue();
});

test('it finds no oops since clear when the flag was set at the first read', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, '128\n');

  const watch = createKernelOopsWatch(ctx.taintPath);

  watch.isOopsed();

  expect(watch.hasOopsedSinceClear()).toBeFalse();
});

test('it finds no oops since clear while the flag stays clear', () => {
  const ctx = setupTest();

  writeFileSync(ctx.taintPath, '0\n');

  const watch = createKernelOopsWatch(ctx.taintPath);

  watch.isOopsed();

  expect(watch.hasOopsedSinceClear()).toBeFalse();
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
