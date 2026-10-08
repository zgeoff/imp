import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubImageMkfs } from './build-stub-image-mkfs';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'stub-image-mkfs-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it holds the write until the test releases it, then runs the real mkfs.ext4', async () => {
  const ctx = await setupTest();

  const mkfs = buildStubImageMkfs(ctx.dir);
  const image = join(ctx.dir, 'rootfs.ext4');

  Bun.spawnSync(['truncate', '-s', '8M', image]);

  const child = Bun.spawn([join(mkfs.bin, 'mkfs.ext4'), '-q', '-F', image], {
    stdout: 'ignore',
    stderr: 'ignore',
  });

  await mkfs.waitForStart();

  mkfs.release();

  const code = await child.exited;
  const magic = await Bun.file(image).slice(1080, 1082).bytes();

  expect(code).toBe(0);
  expect([...magic]).toStrictEqual([0x53, 0xef]);
});

test('it keeps the write waiting while the test holds it', async () => {
  const ctx = await setupTest();

  const mkfs = buildStubImageMkfs(ctx.dir);

  const child = Bun.spawn([join(mkfs.bin, 'mkfs.ext4'), join(ctx.dir, 'none.ext4')], {
    stdout: 'ignore',
    stderr: 'ignore',
  });

  onTestFinished(() => {
    child.kill();
  });

  await mkfs.waitForStart();

  expect(child.exitCode).toBeNull();
});

test('it fails the held write with the stderr the test gives', async () => {
  const ctx = await setupTest();

  const mkfs = buildStubImageMkfs(ctx.dir);

  const child = Bun.spawn([join(mkfs.bin, 'mkfs.ext4'), join(ctx.dir, 'rootfs.ext4')], {
    stdout: 'ignore',
    stderr: 'pipe',
  });

  await mkfs.waitForStart();

  mkfs.fail('no space left on device');

  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

  expect(code).toBe(1);
  expect(stderr).toBe('no space left on device\n');
});

test('it ends a held write with no release once its directory is gone', async () => {
  const ctx = await setupTest();

  const dir = join(ctx.dir, 'stub');
  const mkfs = buildStubImageMkfs(dir);

  const child = Bun.spawn([join(mkfs.bin, 'mkfs.ext4'), join(ctx.dir, 'rootfs.ext4')], {
    stdout: 'ignore',
    stderr: 'ignore',
  });

  onTestFinished(() => {
    child.kill();
  });

  await mkfs.waitForStart();

  await rm(dir, { recursive: true, force: true });

  const code = await child.exited;

  expect(code).toBe(1);
});
