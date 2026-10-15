import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, runImp, runShellInImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { instance, runDevScript } from '../lib/instance';
import {
  buildRaCounterTable,
  buildV6Plan,
  readHostRouting,
  readImpTap,
  readRaCounts,
  readRsAccepts,
  startRaCounter,
  startV6Instance,
  startV6Topology,
  stopRaCounter,
  stopV6Topology,
} from '../lib/ipv6-topology';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// A guest's router advertisement (docs/architecture/network/networking.md#ipv6), on
// the topology's near network behind NAT66. The instance reboots onto it,
// and back to its own network at the end.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return {
    prefix: readSuitePrefix('ipv6'),
    stack,
    client,
    plan: buildV6Plan(instance.portOffset),
  };
}

test('it ignores a guest’s router advertisement, and still accepts its router solicitation', async () => {
  const ctx = await setupTest();

  const rogue = `${ctx.prefix}ra`;

  await startV6Topology(ctx.plan);

  ctx.stack.defer(() => stopV6Topology());

  await startV6Instance(ctx.plan, 'auto');

  ctx.stack.defer(() => runDevScript('reboot'));

  await runImp('new', rogue, '--image', resolveImageName('e2e-ra'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, rogue));

  await waitForExec(rogue);

  // impd's nft input drops a guest's RA before ip6tables, so a counter on the
  // tap's ingress proves it arrived; the reboot onto the topology made the
  // container anew, so no earlier run's table is there
  const tap = await readImpTap(rogue);

  const table = buildRaCounterTable(ctx.prefix);

  await startRaCounter(table, tap);

  ctx.stack.defer(() => stopRaCounter(table));

  const routingBefore = await readHostRouting();

  await runShellInImp(rogue, 'ra-send eth0 2001:db8:66::/64');

  const arrived = await waitFor('the advertisement to reach the tap', async () => {
    const counts = await readRaCounts(table);

    if (!(counts.adverts > 0)) {
      throw new Error(`${String(counts.adverts)} advertisements on ${tap}`);
    }

    return counts;
  });

  const routingAfter = await readHostRouting();
  const acceptsBefore = await readRsAccepts();

  // The control: a solicitation, which the host accepts, shows on both the
  // tap's counter and ip6tables'. The guest solicits only while it takes
  // RAs; the toggle drops its IPv6, so it comes last.
  await runShellInImp(
    rogue,
    'cd /proc/sys/net/ipv6/conf/eth0 && echo 1 > accept_ra && echo 3 > router_solicitations && echo 1 > disable_ipv6 && echo 0 > disable_ipv6',
  );

  const solicited = await waitFor('a solicitation to reach the host', async () => {
    const counts = await readRaCounts(table);
    const accepts = await readRsAccepts();

    if (!(counts.solicits > arrived.solicits && accepts > acceptsBefore)) {
      throw new Error(
        `${String(counts.solicits)} solicitations on ${tap}, ${String(accepts)} accepted, ${String(acceptsBefore)} before`,
      );
    }

    return { counts, accepts };
  });

  expect(arrived.adverts).toBeGreaterThan(0);
  expect(routingAfter).toBe(routingBefore);
  expect(routingAfter).not.toContain('2001:db8:66');
  expect(solicited.counts.solicits).toBeGreaterThan(arrived.solicits);
  expect(solicited.accepts).toBeGreaterThan(acceptsBefore);
});
