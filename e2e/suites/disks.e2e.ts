import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { buildImpDiskPath, parseDfSizeKib } from '../lib/guest-disk';
import {
  createInstanceClient,
  readInfo,
  requireImp,
  runImp,
  runInImp,
  tryImp,
} from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { runInContainer } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// `impz new --disk` and `impz disk resize` on one imp, through each state a
// resize can find it in.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('disks'), stack, client };
}

test('it grows a disk past its image at the first boot, at once while running, on a wake or the next boot, never shrinks it, and fsck finds it clean', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}grow`;

  const info = await readInfo();

  await runImp(
    'new',
    name,
    '--image',
    resolveImageName('e2e-tiny'),
    '--memory',
    '512',
    '--disk',
    '100g',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const row = await requireImp(name);

  const disk = buildImpDiskPath(info.storage.backend, row.id);

  // ext4 keeps a few percent of each size for its own metadata
  const firstBoot = await runInImp(name, 'df', '-k', '/');

  expect(parseDfSizeKib(firstBoot)).toBeGreaterThan(97 * 1024 * 1024);

  await runImp('stop', name);

  const afterFirstBoot = await runInContainer(['e2fsck', '-fn', disk]);

  expect(afterFirstBoot.exitCode, afterFirstBoot.stdout).toBe(0);

  await runImp('start', name);
  await holdImp(name);
  await runImp('disk', 'resize', name, '110g');

  const whileRunning = await runInImp(name, 'df', '-k', '/');

  expect(parseDfSizeKib(whileRunning)).toBeGreaterThan(107 * 1024 * 1024);

  await runImp('hold', name, '0');
  await runImp('sleep', name);
  await runImp('disk', 'resize', name, '120g');
  await runImp('wake', name);
  await holdImp(name);

  const afterWake = await runInImp(name, 'df', '-k', '/');

  expect(parseDfSizeKib(afterWake)).toBeGreaterThan(117 * 1024 * 1024);

  await runImp('stop', name);
  await runImp('disk', 'resize', name, '130g');
  await runImp('start', name);
  await holdImp(name);

  const afterBoot = await runInImp(name, 'df', '-k', '/');

  expect(parseDfSizeKib(afterBoot)).toBeGreaterThan(127 * 1024 * 1024);

  const shrink = await tryImp(['disk', 'resize', name, '64g']);

  expect(shrink).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'impz: BAD_REQUEST: a disk of 65536 MiB is smaller than the disk now; a disk only grows (133120 MiB)\n',
  });

  await runImp('stop', name);

  // The stop wrote the grown filesystem out and asked for a usage pass, about
  // 10 s later. A count from a pass that started before the stop does not
  // hold those blocks, so only a later one counts.
  const stoppedAt = new Date();

  const afterGrows = await runInContainer(['e2fsck', '-fn', disk]);

  expect(afterGrows.exitCode, afterGrows.stdout).toBe(0);

  const usage = await waitFor(
    `a usage count for ${name} measured after its stop`,
    async () => {
      const found = await requireImp(name);

      if (found.diskUsage === undefined || found.diskUsage.measuredAt < stoppedAt) {
        throw new Error(`last count: ${found.diskUsage?.measuredAt.toISOString() ?? 'none'}`);
      }

      return found.diskUsage;
    },
    { timeoutMs: 30_000 },
  );

  expect(usage.isPartial).toBeFalse();
  expect(usage.exclusiveBytes).toBeGreaterThan(0);
});
