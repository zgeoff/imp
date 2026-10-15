import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import {
  assertState,
  createInstanceClient,
  requireImp,
  runImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { runInContainer } from '../lib/instance';
import { listJailMounts } from '../lib/jail-host';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// A jailed VM's cgroup kills it past memory.max, and impd stops the imp and
// says why (docs/architecture/isolation.md#cgroups).

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('jail'), stack, client };
}

test('it stops a VM over its memory limit, says why, and leaves no jail mounted', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}oom`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  await runShellInImp(
    name,
    [
      'mkdir -p /run/fill && mount -t tmpfs -o size=390m tmpfs /run/fill',
      'dd if=/dev/zero of=/run/fill/f bs=1M count=380 2>/dev/null',
    ].join('\n'),
  );

  // A woken VM maps its memory from the snapshot file, which the host can
  // drop; a write makes each page the VM's own, and there is no room for it.
  await runImp('sleep', name);
  await runImp('wake', name);
  await waitForExec(name);

  const row = await requireImp(name);

  await runInContainer([
    'sh',
    '-c',
    `echo ${String(128 * 1024 * 1024)} > /sys/fs/cgroup/imps/${row.id}/memory.max`,
  ]);

  // the exec dies with the VM
  await tryImp([
    'exec',
    name,
    '--',
    'dd',
    'if=/dev/zero',
    'of=/run/fill/f',
    'bs=1M',
    'count=380',
    'conv=notrunc',
  ]);

  await waitFor(`${name} to stop`, () => assertState(name, 'stopped'));

  const stopped = await requireImp(name);
  const mounts = await listJailMounts(`firecracker/${row.id}/`);

  expect(stopped.error).toBe('its memory limit killed firecracker');
  expect(mounts).toStrictEqual([]);
});
