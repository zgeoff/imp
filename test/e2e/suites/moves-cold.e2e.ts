import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, findImp, requireImp, runImp, runImpWith } from '../lib/imp-cli';
import { waitForExec, writeGuestFile } from '../lib/imps';
import { readImpdLogSince } from '../lib/instance';
import { HOST_B, readMoveHosts } from '../lib/move-hosts';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// Moves between A and B on a Docker network, which the harness keeps up for
// the suite (lib/move-hosts.ts); IMP_MOVE_TEST_CIDR allows them off the
// tailnet, and moves-tailnet covers the real peer check.

// one stack for every release, on both hosts
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = readMoveHosts({ tailnet: false });

  const client = await createInstanceClient();
  const clientB = await createInstanceClient(hosts.b);

  return { prefix: readSuitePrefix('moves'), stack, hosts, client, clientB };
}

test('it moves a stopped imp cold with its disk and checkpoint, and boots it on the target', async () => {
  const ctx = await setupTest();

  const cold = `${ctx.prefix}cold`;

  await runImp('new', cold, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, cold));

  await waitForExec(cold);
  await writeGuestFile(cold, '/root/moved', 'cold-ok');
  await runImp('checkpoint', cold, 'mv1');
  await runImp('stop', cold);

  const since = new Date();

  const out = await runImpWith({ env: ctx.hosts.cliEnv }, 'move', cold, HOST_B);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.clientB, cold));

  const left = await findImp(cold);

  expect(out).toContain(`${cold}: moved to ${HOST_B}`);
  expect(left).toBeUndefined();

  // what B received, not what each host runs on: a source that dropped the
  // target's backend would send files between two ZFS hosts
  const form = process.env['IMP_STORAGE_BACKEND'] === 'zfs' ? 'zfs streams' : 'files';

  const logB = await readImpdLogSince(since, ctx.hosts.b);

  expect(logB).toContain(`impd: move: ${cold}: received as ${form}, waiting for the commit`);

  const row = await requireImp(cold, ctx.hosts.b);
  const checkpoints = await runImpWith({ target: ctx.hosts.b }, 'checkpoints', cold, '--json');

  expect(row.state).toBe('stopped');
  expect(checkpoints).toContain('"mv1"');

  await runImpWith({ target: ctx.hosts.b }, 'start', cold);

  const content = await waitFor(`${cold} to boot on B`, () =>
    runImpWith({ target: ctx.hosts.b }, 'exec', cold, '--', 'cat', '/root/moved'),
  );

  expect(content).toBe('cold-ok\n');
});
