import { expect, test } from 'bun:test';
import { findBootFallbacks } from './boot-fallbacks';

test('finds each restore that fell back to the kernel', () => {
  const fallback =
    'impd: e2e-bt-a: boot template ab25669c4d09 failed, booting the kernel: template restore failed: firecracker PATCH /drives/rootfs: 400';

  const log = [
    'impd: e2e-bt-a: restored boot template ab25669c4d09 as pid 41',
    fallback,
    'impd: e2e-life-a: booted pid 52',
  ].join('\n');

  expect(findBootFallbacks(log)).toEqual([fallback]);
});

test('a template build that fails is not a fallback', () => {
  const log = [
    'impd: boot template ab25669c4d09 build failed: no space',
    'impd: e2e-life-a: the boot failed, booting the kernel is no help',
  ].join('\n');

  expect(findBootFallbacks(log)).toEqual([]);
});
