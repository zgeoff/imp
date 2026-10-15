import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, requireImp, runImp, runShellInImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { instance, readImpdLogSince, runCommand, runDevScript } from '../lib/instance';
import {
  buildGuestIpv6,
  buildV6Names,
  buildV6Plan,
  readGuestIpv6,
  readV6HostAddress,
  startV6Instance,
  startV6Topology,
  stopV6Topology,
} from '../lib/ipv6-topology';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// A routed /64 for imps (docs/architecture/network/networking.md#ipv6): the router
// sends the topology's third /64 to the host, and each imp dials out from its
// own address in it. The instance ends back on its own network.

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

test('it moves a sleeping imp to the routed /64 on a cold boot, and it dials out from its own address there', async () => {
  const ctx = await setupTest();

  const open = `${ctx.prefix}open`;

  await startV6Topology(ctx.plan);

  ctx.stack.defer(() => stopV6Topology());

  await startV6Instance(ctx.plan, 'auto');

  ctx.stack.defer(() => runDevScript('reboot'));

  await runImp('new', open, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, open));

  await waitForExec(open);
  await holdImp(open);

  const rebooted = new Date();

  // the reboot sleeps it; its snapshot holds the old prefix
  await startV6Instance(ctx.plan, `${ctx.plan.routed}/64`);

  const hostAddress = await readV6HostAddress();

  await runCommand([
    'docker',
    'exec',
    buildV6Names(instance.container).router,
    'ip',
    '-6',
    'route',
    'replace',
    `${ctx.plan.routed}/64`,
    'via',
    hostAddress,
  ]);

  await waitForExec(open);

  const row = await requireImp(open);
  const address = await readGuestIpv6(open);

  const expected = buildGuestIpv6(ctx.plan.routed, row.ip);

  expect(address).toBe(expected);

  const peer = await waitFor('the routed address to reach the server', async () => {
    const seen = await runShellInImp(
      open,
      `wget -q -T 10 -O- http://[${ctx.plan.server}]/cgi-bin/peer`,
    );

    if (seen !== `[${expected}]`) {
      throw new Error(`the server saw ${seen}`);
    }

    return seen;
  });

  const log = await readImpdLogSince(rebooted);

  expect(peer).toBe(`[${expected}]`);
  expect(log).toContain('the IPv6 prefix changed');
});
