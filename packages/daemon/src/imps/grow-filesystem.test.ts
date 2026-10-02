import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecked } from '../process/run-command';
import { growFilesystem } from './imp-disk';

const MIB = 1024 * 1024;
const HAS_E2FSPROGS = Bun.which('mkfs.ext4') !== null && Bun.which('resize2fs') !== null;

function setupDiskDir() {
  const dir = mkdtempSync(join(tmpdir(), 'impd-grow-test-'));
  const disk = join(dir, 'disk.ext4');

  writeFileSync(disk, '');

  return {
    disk,
    [Symbol.dispose]: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function readBlockCount(disk: string): Promise<number> {
  const header = await runChecked(['dumpe2fs', '-h', disk]);

  return Number(/^Block count:\s+(?<count>\d+)$/m.exec(header)?.groups?.['count']);
}

test.skipIf(!HAS_E2FSPROGS)('the host grows a clean filesystem to fill its file', async () => {
  using dir = setupDiskDir();

  truncateSync(dir.disk, 64 * MIB);

  await runChecked(['mkfs.ext4', '-q', '-F', '-b', '4096', dir.disk]);

  truncateSync(dir.disk, 256 * MIB);

  const isGrown = await growFilesystem(dir.disk);
  const blocks = await readBlockCount(dir.disk);

  expect(isGrown).toBeTrue();
  expect(blocks).toBe((256 * MIB) / 4096);

  // the new groups' inode tables stay unzeroed holes
  await runChecked(['e2fsck', '-fn', dir.disk]);
});

test.skipIf(!HAS_E2FSPROGS)('an unclean filesystem is left for the guest to grow', async () => {
  using dir = setupDiskDir();

  truncateSync(dir.disk, 64 * MIB);

  await runChecked(['mkfs.ext4', '-q', '-F', '-b', '4096', dir.disk]);

  // as after a VM killed with its filesystem mounted
  await runChecked(['debugfs', '-w', '-R', 'ssv state 0', dir.disk]);

  truncateSync(dir.disk, 256 * MIB);

  const isGrown = await growFilesystem(dir.disk);
  const blocks = await readBlockCount(dir.disk);

  expect(isGrown).toBeFalse();
  expect(blocks).toBe((64 * MIB) / 4096);
});
