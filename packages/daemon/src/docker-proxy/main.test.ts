import { expect, test } from 'bun:test';
import path from 'node:path';

const MAIN = path.join(import.meta.dir, 'main.ts');

test('it refuses to start without IMP_HOST_IMAGE, before it opens a socket', () => {
  const result = Bun.spawnSync([process.execPath, MAIN], {
    env: { PATH: process.env['PATH'] ?? '', IMP_HOST_IMAGE: '' },
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain('IMP_HOST_IMAGE is not set');
});

test('it refuses an IMP_BUILD_ISOLATION or an IMP_BUILD_IMAGE impd would refuse', () => {
  for (const [key, value, message] of [
    ['IMP_BUILD_ISOLATION', 'none', 'IMP_BUILD_ISOLATION is none, not imp or host'],
    ['IMP_BUILD_IMAGE', 'busybox:1.37', 'IMP_BUILD_IMAGE is busybox:1.37, not an image by digest'],
  ] as const) {
    const result = Bun.spawnSync([process.execPath, MAIN], {
      env: { PATH: process.env['PATH'] ?? '', IMP_HOST_IMAGE: 'x', [key]: value },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(message);
  }
});
