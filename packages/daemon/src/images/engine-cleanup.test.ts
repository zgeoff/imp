import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createImage } from '../db/images';
import { setupImpTest } from '../imps/test-imps';
import { buildImagePaths } from '../storage/data-layout';

const OLD_ID = `sha256:${'1'.repeat(64)}`;
const NEW_ID = `sha256:${'2'.repeat(64)}`;

// impd with a docker on PATH that logs each `image rm` and runs `lines`
async function setupTest(lines: readonly string[] = []) {
  const harness = await setupImpTest();

  const bin = join(harness.config.dataDir, 'fake-bin');
  const log = join(harness.config.dataDir, 'docker.log');

  mkdirSync(bin, { recursive: true });

  writeFileSync(
    join(bin, 'docker'),
    ['#!/bin/sh', `[ "$1 $2" = "image rm" ] && echo "$3" >>'${log}'`, ...lines, 'exit 0'].join(
      '\n',
    ),
    { mode: 0o755 },
  );

  const savedPath = process.env['PATH'];

  process.env['PATH'] = `${bin}:${savedPath ?? ''}`;

  return {
    harness,
    readRemoved: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    [Symbol.asyncDispose]: async () => {
      process.env['PATH'] = savedPath;

      await harness[Symbol.asyncDispose]();
    },
  };
}

test('the engine image goes with the last row that names it: its reference, then its ID', async () => {
  await using ctx = await setupTest();

  const db = ctx.harness.db;

  await createImage(db, { name: 'one', ref: 'busybox:1.37', digest: OLD_ID, sizeBytes: 1 });
  await createImage(db, { name: 'two', ref: 'busybox:1.37', digest: OLD_ID, sizeBytes: 1 });

  await ctx.harness.images.removeImage('one');

  expect(ctx.readRemoved()).toEqual([]);

  await ctx.harness.images.removeImage('two');

  expect(ctx.readRemoved()).toEqual(['busybox:1.37', OLD_ID]);
});

test('a template names no engine image', async () => {
  await using ctx = await setupTest();

  await createImage(ctx.harness.db, {
    name: 'tpl',
    ref: 'imp:dev',
    digest: 'imp-0001',
    sizeBytes: 1,
    source: 'imp',
    sourceImp: 'dev',
  });

  await ctx.harness.images.removeImage('tpl');

  expect(ctx.readRemoved()).toEqual([]);
});

test('a rebuild removes the image it left untagged, by its ID', async () => {
  // the engine's tag already names the new build
  await using ctx = await setupTest([
    `[ "$1 $2" = "image inspect" ] && echo '[{"Id":"${NEW_ID}","Config":{},"Size":1}]' && exit 0`,
  ]);

  const paths = buildImagePaths(ctx.harness.config.dataDir, NEW_ID);

  // the new image's rootfs exists, so no export runs
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.rootfs, 'ext4');

  await createImage(ctx.harness.db, {
    name: 'web',
    ref: 'imp/web:latest',
    digest: OLD_ID,
    sizeBytes: 1,
  });

  const image = await ctx.harness.images.addImage('imp/web:latest', 'web');

  expect(image.digest).toBe(NEW_ID);
  expect(ctx.readRemoved()).toEqual([OLD_ID]);
});

test('an image the proxy or the engine keeps is logged, and the row goes all the same', async () => {
  await using ctx = await setupTest([
    `[ "$1 $2" = "image rm" ] && echo 'Error response from daemon: conflict: image is being used' >&2 && exit 1`,
  ]);

  const logs = spyOn(console, 'log').mockImplementation(() => {});

  await createImage(ctx.harness.db, {
    name: 'one',
    ref: 'busybox:1.37',
    digest: OLD_ID,
    sizeBytes: 1,
  });

  await ctx.harness.images.removeImage('one');

  const images = await ctx.harness.images.listImages();

  expect(images.map((one) => one.name)).not.toContain('one');
  expect(logs.mock.calls.flat().join('\n')).toContain('kept the engine image busybox:1.37');

  logs.mockRestore();
});
