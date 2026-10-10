import { expect, onTestFinished, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import {
  createParkMiller,
  findContainerProcesses,
  findLostImps,
  findStrayVms,
  listContainerVms,
  listExpectedImpVmCounts,
  listImpVmCounts,
  planChaosRound,
  readContainerId,
  readLoopDevices,
  readSettledImps,
  runChaosFault,
  runChaosStep,
  waitForImpd,
} from '../lib/chaos';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import {
  createInstanceClient,
  listImps,
  requireImp,
  runImp,
  runInImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { instance, runDevScript, runInContainer } from '../lib/instance';
import type { MemoryProof } from '../lib/memory-proof';
import { checkMemoryKept, startMemoryProof } from '../lib/memory-proof';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// Kills of impd, a Firecracker or the container; every imp must stay valid,
// keep its disk, and keep its memory unless the kill could take it. Guests
// of 512 MiB, under 2 GiB in all.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('chaos'), stack, client };
}

test('it keeps every imp valid, with its disk and the memory no kill could take, through seeded rounds of kills, and leaves no stray VM or loop device', async () => {
  const ctx = await setupTest();

  const names = [`${ctx.prefix}a`, `${ctx.prefix}b`, `${ctx.prefix}c`];
  const random = createParkMiller(config.chaosSeed);

  const proofs = new Map<string, MemoryProof>();

  // what each imp's disk must still hold
  const markers = new Map<string, string>();

  console.log(`    chaos seed ${String(config.chaosSeed)} (E2E_CHAOS_SEED replays it)`);

  for (const name of names) {
    await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '512');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

    await waitForExec(name);
    await runShellInImp(name, `echo '${name} 0' > /root/chaos-marker && sync`);

    markers.set(name, `${name} 0`);

    // only the rounds' own operations sleep them
    await holdImp(name);

    const proof = await startMemoryProof(name);

    proofs.set(name, proof);
  }

  const failed = new Set<string>();

  // the property runner: each round's plan comes from the seeded draws
  for (let round = 1; round <= config.chaosRounds; round += 1) {
    const live = names.filter((name) => !failed.has(name));

    for (const name of live) {
      const marker = `${name} ${String(config.chaosSeed)} ${String(round)}`;

      // synced: the last write before a kill survives it
      await runShellInImp(name, `echo '${marker}' > /root/chaos-marker && sync`);

      markers.set(name, marker);
    }

    const rows = await listImps();

    const idsByName = new Map(rows.map((row) => [row.name, row.id]));

    // an imp in error takes no exec to hold across the fault
    const plan = planChaosRound(random, live);
    const steps = plan.steps.map((step) => `${step.op} ${step.name}`).join(', ');

    console.log(
      `    round ${String(round)}: ${steps}; ${plan.fault} after ${String(plan.delayMs)}ms`,
    );

    let settledSteps = 0;

    const running = Promise.allSettled(
      plan.steps.map(async (step) => {
        await runChaosStep(step);

        settledSteps += 1;
      }),
    );

    // the fault lands among the operations, at the seeded offset
    await Bun.sleep(plan.delayMs);

    const inFlight = plan.steps.length - settledSteps;

    const fault = await runChaosFault(plan.fault, names, idsByName, random);

    await running;
    await waitForImpd();

    const lost = findLostImps(plan, fault.taken);

    const settled = await readSettledImps(names);
    const vms = await listContainerVms();

    // the fault overlapped an operation, and killed something
    expect(inFlight).toBeGreaterThan(0);
    expect(fault.killed).not.toBeEmpty();

    // each awake imp has exactly the one VM its record says
    expect(listImpVmCounts(settled, vms)).toStrictEqual(listExpectedImpVmCounts(settled, vms));
    expect(findStrayVms(settled, vms)).toStrictEqual([]);

    const errored = settled.filter((row) => row.state === 'error' && names.includes(row.name));

    // an adopt leaves an imp whose VM outlived SIGKILL in `error`
    for (const row of errored) {
      console.log(`    ${row.name}: error after round ${String(round)}; left out from here`);
      failed.add(row.name);
    }

    for (const name of names.filter((candidate) => !failed.has(candidate))) {
      const disk = await runInImp(name, 'cat', '/root/chaos-marker');

      const proof = proofs.get(name);

      invariant(proof);

      // the disk always survives; the memory only where nothing could take it
      const isKept = await checkMemoryKept(proof);

      expect(`${name}: ${disk}`).toBe(`${name}: ${markers.get(name) ?? ''}`);

      if (!isKept) {
        expect(`${name} ${lost.has(name) ? 'may lose' : 'keeps'} its memory`).toBe(
          `${name} may lose its memory`,
        );

        await holdImp(name);

        const fresh = await startMemoryProof(name);

        proofs.set(name, fresh);
      }
    }
  }

  const devices = await readLoopDevices();
  const containerId = await readContainerId();
  const vms = await listContainerVms();
  const after = await listImps();

  const awake = after.filter((row) => row.state === 'running').length;
  const processes = findContainerProcesses(containerId);

  // the instance's own mount, and one VM per running imp
  expect(devices.length).toBeLessThanOrEqual(1);
  expect([...vms.values()].flat()).toHaveLength(awake);
  expect(processes.length).toBeGreaterThan(0);
});

test('it restarts a paused VM whose agent stops answering with the watchdog', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}dog`;

  // in-test: the rounds would trip a watchdog this short, and DISK_FULL's
  // reserve would refuse their sleeps
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

test('it keeps an imp awake with DISK_FULL when the disk cannot take its sleep', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}full`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  // A reserve past any test disk: a wake still goes through, a sleep not.
  // In-test, since the suite's other tests need their sleeps; the imp comes
  // first, as no create fits the reserve.
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
