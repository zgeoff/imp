import { expect, test } from 'bun:test';
import { findBootFallbacks } from './boot-fallbacks';

test('it finds each template restore that fell back to the kernel', () => {
  const log = [
    'impd: e2e-bt-a: restored boot template ab25669c4d09 as pid 41',
    'impd: e2e-bt-a: boot template ab25669c4d09 failed, booting the kernel: template restore failed: firecracker PATCH /drives/rootfs: 400',
    'impd: e2e-life-a: booted pid 52',
  ].join('\n');

  expect(findBootFallbacks(log)).toStrictEqual([
    'impd: e2e-bt-a: boot template ab25669c4d09 failed, booting the kernel: template restore failed: firecracker PATCH /drives/rootfs: 400',
  ]);
});

test('it finds no fallback in a failed template build or a failed kernel boot', () => {
  const log = [
    'impd: boot template ab25669c4d09 build failed: no space',
    'impd: e2e-life-a: the boot failed, booting the kernel is no help',
  ].join('\n');

  expect(findBootFallbacks(log)).toStrictEqual([]);
});
