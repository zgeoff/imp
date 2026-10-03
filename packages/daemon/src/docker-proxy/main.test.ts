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
