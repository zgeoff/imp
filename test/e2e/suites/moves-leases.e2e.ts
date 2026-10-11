import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, runImp, runImpWith } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { HOST_B, readMoveHosts } from '../lib/move-hosts';
import { listLeasesOn, sendHostRpc } from '../lib/move-steps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';

// A stop move and the leases on its imp, between A and B on the harness's
// move network (lib/move-hosts.ts).

// one stack for every release, on both hosts
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = readMoveHosts({ tailnet: false });

  const client = await createInstanceClient();
  const clientB = await createInstanceClient(hosts.b);

  return { prefix: readSuitePrefix('moves'), stack, hosts, client, clientB };
}

test('it ends the leases a client took on a stop move, and brings the hold over with its time left', async () => {
  const ctx = await setupTest();

  const leased = `${ctx.prefix}leased`;

  await runImp('new', leased, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, leased));

  await waitForExec(leased);

  const acquired = await sendHostRpc(ctx.hosts.a, 'leases/acquire', {
    name: leased,
    label: 'job',
    ttlSeconds: 600,
  });

  await runImp('hold', leased, '30m');

  // the source's own route refuses the move while a client's lease stands
  const refused = await sendHostRpc(ctx.hosts.a, 'moves/prepare', {
    name: leased,
    stop: true,
    targetStorage: 'xfs',
  });

  expect(acquired.ok).toBeTrue();
  expect(refused.ok).toBeFalse();
  expect(refused.body).toMatchObject({ code: 'LEASED' });

  const before = Date.now();

  const out = await runImpWith({ env: ctx.hosts.cliEnv }, 'move', leased, HOST_B, '--stop');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.clientB, leased));

  const after = Date.now();

  const leases = await listLeasesOn(ctx.hosts.b, leased);

  expect(out).toContain(`${leased}: moved to ${HOST_B}`);

  expect(leases.map((lease) => [lease.owner.principal, lease.owner.label])).toStrictEqual([
    ['root', 'hold'],
  ]);

  // the hold ends 30 minutes after the hold, as B's clock counts it
  const until = Date.parse(leases[0]?.until ?? '');

  expect(until).toBeGreaterThan(before + 29 * 60_000);
  expect(until).toBeLessThanOrEqual(after + 30 * 60_000);

  // B's root is the hold's owner: its `hold 0` releases it
  await runImpWith({ target: ctx.hosts.b }, 'hold', leased, '0');

  const released = await listLeasesOn(ctx.hosts.b, leased);

  expect(released).toStrictEqual([]);
});
