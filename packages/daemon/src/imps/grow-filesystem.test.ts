import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecked } from '../process/run-command';
import { growFilesystem } from './imp-disk';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'impd-grow-test-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const disk = join(dir, 'disk.ext4');

  writeFileSync(disk, '');

  return { disk };
}

test.skipIf(Bun.which('mkfs.ext4') === null || Bun.which('resize2fs') === null)(
  'it grows a clean filesystem to fill its file',
  async () => {
    const ctx = setupTest();

    truncateSync(ctx.disk, 64 * 1024 * 1024);

    await runChecked(['mkfs.ext4', '-q', '-F', '-b', '4096', ctx.disk]);

    truncateSync(ctx.disk, 256 * 1024 * 1024);

    const isGrown = await growFilesystem(ctx.disk);
    const header = await runChecked(['dumpe2fs', '-h', ctx.disk]);

    expect(isGrown).toBeTrue();

    // 256 MiB of 4096-byte blocks
    expect(header).toMatch(/^Block count:\s+65536$/m);
  },
);

test.skipIf(Bun.which('mkfs.ext4') === null || Bun.which('resize2fs') === null)(
  'it leaves the new inode tables of a grown filesystem as holes a check accepts',
  async () => {
    const ctx = setupTest();

    truncateSync(ctx.disk, 64 * 1024 * 1024);

    await runChecked(['mkfs.ext4', '-q', '-F', '-b', '4096', ctx.disk]);

    truncateSync(ctx.disk, 256 * 1024 * 1024);

    await growFilesystem(ctx.disk);

    await expect(runChecked(['e2fsck', '-fn', ctx.disk])).toResolve();
  },
);

test.skipIf(Bun.which('mkfs.ext4') === null || Bun.which('resize2fs') === null)(
  'it leaves an unclean filesystem for the guest to grow',
  async () => {
    const ctx = setupTest();

    truncateSync(ctx.disk, 64 * 1024 * 1024);

    await runChecked(['mkfs.ext4', '-q', '-F', '-b', '4096', ctx.disk]);

    // as after a VM killed with its filesystem mounted
    await runChecked(['debugfs', '-w', '-R', 'ssv state 0', ctx.disk]);

    truncateSync(ctx.disk, 256 * 1024 * 1024);

    const isGrown = await growFilesystem(ctx.disk);
    const header = await runChecked(['dumpe2fs', '-h', ctx.disk]);

    expect(isGrown).toBeFalse();

    // still 64 MiB of 4096-byte blocks
    expect(header).toMatch(/^Block count:\s+16384$/m);
  },
);
