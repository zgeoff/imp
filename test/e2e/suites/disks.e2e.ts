import { expect, test } from 'bun:test';
import { resolveImageName } from '../lib/fixtures';
import { readInfo, requireImp, runImp, runInImp } from '../lib/imp-cli';
import { createImp, holdImp } from '../lib/imps';
import { runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

const prefix = setupSuite('disks');
const TINY = resolveImageName('e2e-tiny');
const imp = `${prefix}grow`;
const GIB_KIB = 1024 * 1024;

// the root filesystem's size in GiB, as the guest's df reports it
async function readGuestDiskGib(name: string): Promise<number> {
  const stdout = await runInImp(name, 'df', '-k', '/');

  const sizeKib = Number(stdout.trim().split('\n').at(-1)?.split(/\s+/)[1]);

  return sizeKib / GIB_KIB;
}

async function findDiskFile(id: string): Promise<string> {
  const info = await readInfo();

  return info.storage.backend === 'xfs'
    ? `/var/lib/imp/imps/${id}/disk.ext4`
    : `/var/lib/imp/imps/${id}/disk/rootfs.ext4`;
}

// a forced, read-only fsck of the stopped imp's disk
async function checkDiskClean(name: string): Promise<void> {
  const found = await requireImp(name);
  const disk = await findDiskFile(found.id);
  const result = await runInContainer(['e2fsck', '-fn', disk]);

  expect({ disk, exitCode: result.exitCode }).toEqual({ disk, exitCode: 0 });
}

test('a disk grows past its image on the first boot, and fsck finds it clean', async () => {
  await createImp(imp, '--image', TINY, '--memory', '512', '--disk', '100g');
  await holdImp(imp);

  // ext4 keeps a few percent for its own metadata
  const size1 = await readGuestDiskGib(imp);

  expect(size1).toBeGreaterThan(97);

  await runImp('stop', imp);
  await checkDiskClean(imp);
});

test('a running guest grows into a resize at once, a sleeping one on its wake', async () => {
  await runImp('start', imp);
  await holdImp(imp);
  await runImp('disk', 'resize', imp, '110g');

  const size2 = await readGuestDiskGib(imp);

  expect(size2).toBeGreaterThan(107);

  await runImp('hold', imp, '0');
  await runImp('sleep', imp);
  await runImp('disk', 'resize', imp, '120g');
  await runImp('wake', imp);
  await holdImp(imp);

  const size3 = await readGuestDiskGib(imp);

  expect(size3).toBeGreaterThan(117);
});

test('a stopped disk grows at its next boot, and never shrinks', async () => {
  await runImp('stop', imp);
  await runImp('disk', 'resize', imp, '130g');
  await runImp('start', imp);
  await holdImp(imp);

  const size4 = await readGuestDiskGib(imp);

  expect(size4).toBeGreaterThan(127);

  const shrink = await runImp('disk', 'resize', imp, '64g').catch((error: unknown) => error);

  expect(String(shrink)).toContain('a disk only grows');

  // a pass runs about 10 s after the create; the grown filesystem wrote
  // blocks of its own
  const usage = await waitFor(
    `a usage count for ${imp}`,
    async () => {
      const found = await requireImp(imp);

      if (found.diskUsage === undefined) {
        throw new Error('no pass has counted it yet');
      }

      return found.diskUsage;
    },
    { timeoutMs: 30_000 },
  );

  expect(usage.isPartial).toBeFalse();
  expect(usage.exclusiveBytes).toBeGreaterThan(0);

  await runImp('stop', imp);
  await checkDiskClean(imp);
  await runImp('rm', imp);
});
