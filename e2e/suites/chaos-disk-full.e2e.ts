import { expect, onTestFinished, test } from 'bun:test';
import { findStrayVms, listContainerVms, readLoopDevices, waitForImpd } from '../lib/chaos';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, listImps, requireImp, runImp, tryImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { instance, runDevScript } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';

// A disk that cannot take a sleep's memory file (IMP_DISK_RESERVE_GIB):
// impd refuses the sleep with DISK_FULL and the imp stays awake.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('chaos'), stack, client };
}

test('it keeps an imp awake with DISK_FULL when the disk cannot take its sleep', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}full`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  // A reserve past any test disk: a wake still goes through, a sleep not.
  // This journey's own settings, back to the run's at its end; the imp
  // comes first, as no create fits the reserve.
  await runDevScript('reboot', instance, { IMP_DISK_RESERVE_GIB: '100000' });

  ctx.stack.defer(() => runDevScript('reboot'));

  await waitForImpd();

  // no VM or loop device outlives the reboot
  const devices = await readLoopDevices();
  const vms = await listContainerVms();
  const rows = await listImps();

  await runImp('wake', name);

  const result = await tryImp(['sleep', name]);
  const after = await requireImp(name);

  expect(devices.length).toBeLessThanOrEqual(1);
  expect(findStrayVms(rows, vms)).toStrictEqual([]);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: expect.toStartWith('imp: DISK_FULL: '),
  });

  expect(after.state).toBe('running');
});
