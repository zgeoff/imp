import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import {
  assertState,
  createInstanceClient,
  requireImp,
  runImp,
  runShellInImp,
} from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { checkHealthReady, runDevScript } from '../lib/instance';
import {
  findJailViolations,
  listJailMounts,
  readImpCgroupText,
  readJailState,
  readVmProcess,
} from '../lib/jail-host';
import { checkMemoryProof, startMemoryProof } from '../lib/memory-proof';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// The jailer (docs/architecture/host-contract.md): each VM in its own uid,
// cgroup and mount namespace. One imp boots jailed, sleeps and wakes full,
// and outlives an impd restart.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('jail'), stack, client };
}

test('it runs a new imp jailed under a memory cap, sleeps and wakes it full under the cap, and re-adopts it across an impd restart', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}box`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const booted = await readJailState(name);

  expect(findJailViolations(booted)).toStrictEqual([]);

  await waitFor(`a RAM sample for ${name}`, async () => {
    const row = await requireImp(name);

    expect(row.ramMib).toBeGreaterThan(0);
  });

  // a little over the guest, with no swap
  const max = await readImpCgroupText(name, 'memory.max');
  const high = await readImpCgroupText(name, 'memory.high');
  const swapMax = await readImpCgroupText(name, 'memory.swap.max');
  const oomGroup = await readImpCgroupText(name, 'memory.oom.group');

  expect(Number(max)).toBe((512 + 256) * 1024 * 1024);
  expect(high).toBe('max');
  expect(swapMax).toBe('0');
  expect(oomGroup).toBe('1');

  const proof = await startMemoryProof(name);

  // 380 MiB of tmpfs: most of the VM's RAM
  await runShellInImp(
    name,
    [
      'mkdir -p /run/fill && mount -t tmpfs -o size=390m tmpfs /run/fill',
      'dd if=/dev/zero of=/run/fill/f bs=1M count=380 2>/dev/null',
    ].join('\n'),
  );

  await runImp('sleep', name);
  await assertState(name, 'sleeping');

  const asleepEvents = await readImpCgroupText(name, 'memory.events');

  // the imp's own jail: a boot template build has its own while it runs
  const asleepMounts = await listJailMounts(`firecracker/${booted.impId}/`);

  expect(asleepEvents).toMatch(/^oom_kill 0$/m);
  expect(asleepMounts).toStrictEqual([]);

  await runImp('wake', name);
  await waitForExec(name);
  await checkMemoryProof(proof);

  // every page of the fill back in the VM, not only those the wake touched
  const size = await runShellInImp(name, 'cat /run/fill/f | wc -c');
  const wokeEvents = await readImpCgroupText(name, 'memory.events');
  const peak = await readImpCgroupText(name, 'memory.peak');
  const woke = await readJailState(name);

  expect(Number(size)).toBe(380 * 1024 * 1024);
  expect(wokeEvents).toMatch(/^oom_kill 0$/m);
  expect(Number(peak)).toBeLessThanOrEqual((512 + 256) * 1024 * 1024);
  expect(findJailViolations(woke)).toStrictEqual([]);

  const beforeRestart = await readVmProcess(name);

  await runDevScript('restart');

  await waitFor('impd to be ready', async () => {
    const isReady = await checkHealthReady();

    expect(isReady).toBeTrue();
  });

  const afterRestart = await readVmProcess(name);

  expect(afterRestart.pid).toBe(beforeRestart.pid);

  await assertState(name, 'running');
  await checkMemoryProof(proof);

  await waitFor(`a RAM sample for ${name} after the restart`, async () => {
    const row = await requireImp(name);

    expect(row.ramMib).toBeGreaterThan(0);
  });
});
