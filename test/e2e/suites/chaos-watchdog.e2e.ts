import { expect, onTestFinished, test } from 'bun:test';
import { findStrayVms, listContainerVms, readLoopDevices, waitForImpd } from '../lib/chaos';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, listImps, requireImp, runImp, runInImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { instance, runDevScript, runInContainer } from '../lib/instance';
import { checkMemoryKept, startMemoryProof } from '../lib/memory-proof';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// The watchdog (IMP_WATCHDOG_ACTION) on a guest that stops answering: impd
// boots it cold, so what only its memory held is gone.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('chaos'), stack, client };
}

test('it restarts a paused VM whose agent stops answering with the watchdog', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}dog`;

  // this journey's own settings, back to the run's at its end: a watchdog
  // this short would trip during the seeded kill rounds
  await runDevScript('reboot', instance, {
    IMP_WATCHDOG_ACTION: 'restart',
    IMP_WATCHDOG_TIMEOUT_S: '10',
  });

  ctx.stack.defer(() => runDevScript('reboot'));

  await waitForImpd();

  // no VM or loop device outlives the reboot
  const devices = await readLoopDevices();
  const vms = await listContainerVms();
  const rows = await listImps();

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const proof = await startMemoryProof(name);
  const row = await requireImp(name);

  // the guest stops; Firecracker and its socket stay
  await runInContainer([
    'curl',
    '-fsS',
    '--unix-socket',
    `/var/lib/imp/imps/${row.id}/run/api.sock`,
    '-X',
    'PATCH',
    'http://localhost/vm',
    '-d',
    '{"state":"Paused"}',
  ]);

  const restarted = await waitFor(
    `${name} to boot cold by the watchdog`,
    async () => {
      const current = await requireImp(name);

      if (!(current.coldBootReason ?? '').includes('watchdog')) {
        throw new Error(`cold boot reason ${current.coldBootReason ?? 'none'}`);
      }

      return current;
    },
    { timeoutMs: 120_000 },
  );

  await runInImp(name, 'true');

  const isKept = await checkMemoryKept(proof);

  expect(devices.length).toBeLessThanOrEqual(1);
  expect(findStrayVms(rows, vms)).toStrictEqual([]);
  expect(restarted.coldBootReason).toContain('watchdog');
  expect(isKept).toBeFalse();
});
