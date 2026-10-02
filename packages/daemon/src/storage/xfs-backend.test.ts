import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createXfsBackend } from './xfs-backend';

function setupTest() {
  const dataDir = mkdtempSync(`${tmpdir()}/impd-xfs-test-`);

  return {
    dataDir,
    backend: createXfsBackend({ dataDir }),
    imageDir: join(dataDir, 'images', 'abc'),
    [Symbol.dispose]: () => {
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function writeImage(dir: string): Promise<void> {
  writeFileSync(join(dir, 'rootfs.ext4'), 'rootfs');
  writeFileSync(join(dir, 'config.json'), '{}');

  return Promise.resolve();
}

test('an image replaces a directory a crash left with no rootfs', async () => {
  using ctx = setupTest();

  // what impd before the storage backends left when it died mid-build
  mkdirSync(ctx.imageDir, { recursive: true });
  writeFileSync(join(ctx.imageDir, 'config.json'), '{"old":true}');

  await ctx.backend.createImage('sha256:abc', writeImage);

  expect(readFileSync(join(ctx.imageDir, 'rootfs.ext4'), 'utf8')).toBe('rootfs');
  expect(readFileSync(join(ctx.imageDir, 'config.json'), 'utf8')).toBe('{}');
});

test('start sweeps image builds a crash cut short', async () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.dataDir, 'images', '.new-crashed'), { recursive: true });
  mkdirSync(ctx.imageDir, { recursive: true });

  await ctx.backend.start({ impIds: new Set(), checkpointIds: new Set(), imageDigests: new Set() });

  expect(readdirSync(join(ctx.dataDir, 'images'))).toEqual(['abc']);
  expect(existsSync(ctx.imageDir)).toBeTrue();
});
