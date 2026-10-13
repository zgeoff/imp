import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { getThroughProxy } from '../lib/http';
import {
  assertState,
  createInstanceClient,
  readState,
  runImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { holdImp, readGuestFile, waitForExec, writeGuestFile } from '../lib/imps';
import { checkHealthReady, findImpdPid, runDevScript } from '../lib/instance';
import { checkMemoryProof, startMemoryProof } from '../lib/memory-proof';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { buildKeptScaleFleet, listAwakeImps, readInventory } from '../lib/restart-inventory';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// impd restarts and instance reboots keep every imp (docs/runbooks/development.md).
// The inventory holds every imp on the instance: in the acceptance run that
// is scale's fleet too, which the harness keeps for this suite.

// one stack for every release
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('restart'), stack, client };
}

test('it re-adopts running VMs across an impd restart, wakes a sleeper and restores a checkpoint, then sleeps every imp across a reboot', async () => {
  const ctx = await setupTest();

  const disk = `${ctx.prefix}disk`;
  const mem = `${ctx.prefix}mem`;
  const stopped = `${ctx.prefix}stopped`;

  // a running imp with a checkpoint and a later write
  await runImp('new', disk, '--image', resolveImageName('e2e-tiny'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, disk));

  await waitForExec(disk);
  await holdImp(disk);
  await writeGuestFile(disk, '/root/f', 'r1');
  await runImp('checkpoint', disk, 'r1');
  await writeGuestFile(disk, '/root/f', 'r2');

  const diskBootId = await runShellInImp(disk, 'cat /proc/sys/kernel/random/boot_id');

  // a sleeping imp whose memory holds a proof
  await runImp('new', mem, '--image', resolveImageName('e2e-bare'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, mem));

  await waitForExec(mem);

  const proof = await startMemoryProof(mem);

  // the idle sleeper may get there first
  await tryImp(['sleep', mem]);
  await waitFor(`${mem} to sleep`, () => assertState(mem, 'sleeping'));

  // a stopped imp
  await runImp('new', stopped, '--image', resolveImageName('e2e-tiny'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, stopped));

  await waitForExec(stopped);
  await runImp('stop', stopped);

  const beforeRestart = await readInventory();
  const oldPid = await findImpdPid();

  console.log(`    ${String(beforeRestart.length)} imps before the restart`);

  // scale's whole fleet when the harness kept it for this suite, and none of
  // it otherwise
  const scaleFleet = beforeRestart
    .map((entry) => entry.name)
    .filter((name) => name.startsWith(readSuitePrefix('scale')));

  expect(scaleFleet).toStrictEqual(buildKeptScaleFleet(config.keptPrefixes, config.scaleCount));

  const restarting = Date.now();

  // dev.sh restart can return while the old impd still answers /health, so
  // wait for a new impd process before trusting readiness
  await runDevScript('restart');

  const newPid = await waitFor(
    'a new impd process',
    async () => {
      const pid = await findImpdPid();

      if (pid === null || pid === oldPid) {
        throw new Error(`impd pid ${String(pid)}, was ${String(oldPid)}`);
      }

      return pid;
    },
    { timeoutMs: 180_000 },
  );

  await waitFor(
    'the new impd to be ready',
    async () => {
      const ready = await checkHealthReady();

      if (!ready) {
        throw new Error('impd is not ready');
      }
    },
    { timeoutMs: 120_000 },
  );

  writeMetric('restartMs', Date.now() - restarting);

  const afterRestart = await readInventory();
  const diskState = await readState(disk);
  const bootId = await runShellInImp(disk, 'cat /proc/sys/kernel/random/boot_id');
  const file = await readGuestFile(disk, '/root/f');
  const stoppedState = await readState(stopped);

  expect(oldPid).not.toBeNull();
  expect(newPid).not.toBe(oldPid);
  expect(afterRestart).toStrictEqual(beforeRestart);

  // re-adopted, not rebooted: the same boot and the latest write
  expect(diskState).toBe('running');
  expect(bootId).toBe(diskBootId);
  expect(file).toBe('r2');
  expect(stoppedState).toBe('stopped');

  // the sleeper wakes with its memory after the restart
  const woken = await getThroughProxy(mem);

  expect(woken).toBe(proof.token);

  await checkMemoryProof(proof);

  // a checkpoint taken before the restart restores
  await runImp('restore', disk, 'r1');
  await waitForExec(disk);

  const restored = await readGuestFile(disk, '/root/f');

  expect(restored).toBe('r1');

  // stopping the instance sleeps every imp, and they wake intact
  await holdImp(mem);

  const beforeReboot = await readInventory();

  const rebooting = Date.now();

  // dev.sh reboot: SIGTERM makes impd sleep every VM before it exits
  await runDevScript('reboot');

  writeMetric('rebootMs', Date.now() - rebooting);

  const afterReboot = await readInventory();
  const awake = await listAwakeImps();
  const memState = await readState(mem);
  const stoppedAfterReboot = await readState(stopped);

  expect(afterReboot).toStrictEqual(beforeReboot);
  expect(awake).toStrictEqual([]);
  expect(memState).toBe('sleeping');
  expect(stoppedAfterReboot).toBe('stopped');

  const body = await getThroughProxy(mem);

  expect(body).toBe(proof.token);

  await checkMemoryProof(proof);
});
