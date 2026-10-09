import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, realpathSync, statfsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findLoopBackingFile, readLoopHostFreeBytes } from './loop-backing-file';

async function setupTest() {
  const made = await mkdtemp(join(tmpdir(), 'loop-backing-file-'));

  // mountinfo names the real path, which the unit resolves the dir to
  const root = realpathSync(made);

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  // procfs and sysfs as trees under the root, and the dir a test mounts
  const procDir = join(root, 'proc');
  const sysDir = join(root, 'sys');
  const mountDir = join(root, 'mnt');

  mkdirSync(join(procDir, 'self'), { recursive: true });
  mkdirSync(sysDir);
  mkdirSync(mountDir);

  return { root, procDir, sysDir, mountDir };
}

test('#findLoopBackingFile names the file behind the loop device mounted on a dir', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.procDir, 'self', 'mountinfo'),
    `22 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n98 22 7:3 / ${ctx.mountDir} rw,relatime - xfs /dev/loop3 rw,attr2\n`,
  );

  mkdirSync(join(ctx.sysDir, 'block', 'loop3', 'loop'), { recursive: true });
  writeFileSync(join(ctx.sysDir, 'block', 'loop3', 'loop', 'backing_file'), '/srv/imp/xfs.img\n');

  expect(findLoopBackingFile(ctx.mountDir, { procDir: ctx.procDir, sysDir: ctx.sysDir })).toBe(
    '/srv/imp/xfs.img',
  );
});

test('#findLoopBackingFile finds nothing behind a mount of a disk that is no loop device', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.procDir, 'self', 'mountinfo'),
    `98 22 8:1 / ${ctx.mountDir} rw,relatime - ext4 /dev/sda1 rw\n`,
  );

  expect(
    findLoopBackingFile(ctx.mountDir, { procDir: ctx.procDir, sysDir: ctx.sysDir }),
  ).toBeNull();
});

test('#findLoopBackingFile finds nothing when the loop driver is unreadable in sysfs', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.procDir, 'self', 'mountinfo'),
    `98 22 7:3 / ${ctx.mountDir} rw,relatime - xfs /dev/loop3 rw,attr2\n`,
  );

  expect(
    findLoopBackingFile(ctx.mountDir, { procDir: ctx.procDir, sysDir: ctx.sysDir }),
  ).toBeNull();
});

test('#findLoopBackingFile finds nothing when mountinfo is unreadable', async () => {
  const ctx = await setupTest();

  expect(
    findLoopBackingFile(ctx.mountDir, { procDir: ctx.procDir, sysDir: ctx.sysDir }),
  ).toBeNull();
});

test('#readLoopHostFreeBytes reads the free bytes of the directory that holds the loop file', async () => {
  const ctx = await setupTest();

  const hostDir = join(ctx.root, 'host');

  mkdirSync(hostDir);

  writeFileSync(
    join(ctx.procDir, 'self', 'mountinfo'),
    `98 22 7:3 / ${ctx.mountDir} rw,relatime - xfs /dev/loop3 rw,attr2\n`,
  );

  mkdirSync(join(ctx.sysDir, 'block', 'loop3', 'loop'), { recursive: true });

  writeFileSync(
    join(ctx.sysDir, 'block', 'loop3', 'loop', 'backing_file'),
    join(hostDir, 'xfs.img'),
  );

  const hostFree = statfsSync(hostDir);
  const expected = hostFree.bavail * hostFree.bsize;

  // other writers share the host's filesystem, so its free space may move a little
  expect(
    readLoopHostFreeBytes(ctx.mountDir, { procDir: ctx.procDir, sysDir: ctx.sysDir }),
  ).toBeWithin(expected - 64 * 1024 ** 2, expected + 64 * 1024 ** 2);
});

test('#readLoopHostFreeBytes reads nothing for a dir that is no loop mount', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.procDir, 'self', 'mountinfo'),
    '22 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n',
  );

  expect(
    readLoopHostFreeBytes(ctx.mountDir, { procDir: ctx.procDir, sysDir: ctx.sysDir }),
  ).toBeNull();
});

test('#readLoopHostFreeBytes reads nothing when the loop file sits in a directory that is gone', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.procDir, 'self', 'mountinfo'),
    `98 22 7:3 / ${ctx.mountDir} rw,relatime - xfs /dev/loop3 rw,attr2\n`,
  );

  mkdirSync(join(ctx.sysDir, 'block', 'loop3', 'loop'), { recursive: true });

  writeFileSync(
    join(ctx.sysDir, 'block', 'loop3', 'loop', 'backing_file'),
    join(ctx.root, 'gone', 'xfs.img'),
  );

  expect(
    readLoopHostFreeBytes(ctx.mountDir, { procDir: ctx.procDir, sysDir: ctx.sysDir }),
  ).toBeNull();
});
