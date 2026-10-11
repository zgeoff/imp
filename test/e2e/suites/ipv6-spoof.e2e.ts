import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { tryDialFromImp } from '../lib/guest-probe';
import { createInstanceClient, runImp, runShellInImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { instance, runDevScript } from '../lib/instance';
import {
  buildV6Plan,
  readGuestIpv6,
  startV6Instance,
  startV6Topology,
  stopV6Topology,
} from '../lib/ipv6-topology';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';

// Spoofed IPv6 sources (docs/architecture/networking.md#ipv6), on the
// topology's near network behind NAT66. The instance reboots onto it, and
// back to its own network at the end.

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

test('it drops an imp’s IPv6 packets from outside its prefix or from another imp’s address', async () => {
  const ctx = await setupTest();

  const image = resolveImageName('e2e-tiny');
  const spoofer = `${ctx.prefix}spoof-a`;
  const victim = `${ctx.prefix}spoof-b`;
  const server = ctx.plan.server;

  await startV6Topology(ctx.plan);

  ctx.stack.defer(() => stopV6Topology());

  await startV6Instance(ctx.plan, 'auto');

  ctx.stack.defer(() => runDevScript('reboot'));

  await runImp('new', spoofer, '--image', image, '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, spoofer));

  await waitForExec(spoofer);
  await holdImp(spoofer);
  await runImp('new', victim, '--image', image, '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, victim));

  await waitForExec(victim);
  await holdImp(victim);

  // Spoofed from outside the prefix, and as another imp: the host's rpfilter
  // drops both before the slot chain's own source check
  const own = await readGuestIpv6(spoofer);
  const victimAddress = await readGuestIpv6(victim);

  const farSpoof = `${ctx.plan.far}77`;

  // before the spoofed addresses, which the guest would pick as its source
  const spoofControl = await tryDialFromImp(spoofer, server, 80);

  await runShellInImp(
    spoofer,
    [
      'echo 0 > /proc/sys/net/ipv6/conf/eth0/accept_dad',
      `ip -6 addr add ${farSpoof}/128 dev eth0`,
      `ip -6 addr add ${victimAddress}/128 dev eth0`,
    ].join(' && '),
  );

  const fromOwn = await tryDialFromImp(spoofer, server, 80, own);
  const fromFar = await tryDialFromImp(spoofer, server, 80, farSpoof);
  const fromVictim = await tryDialFromImp(spoofer, server, 80, victimAddress);

  expect(spoofControl).toBeTrue();
  expect(fromOwn).toBeTrue();
  expect(fromFar).toBeFalse();
  expect(fromVictim).toBeFalse();
});
