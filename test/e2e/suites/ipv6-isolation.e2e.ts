import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { tryDialFromImp, tryGetFromImp, tryInImp } from '../lib/guest-probe';
import { createInstanceClient, runImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { instance, runCommand, runDevScript, runInContainer } from '../lib/instance';
import {
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

// Isolation over IPv6 (docs/architecture/networking.md#ipv6): an imp reaches
// neither another imp nor the host, on the topology's near network behind
// NAT66. The instance reboots onto it, and back to its own network at the end.

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

test('it isolates an imp over IPv6 from another imp, the host and the router, while the router reaches the host', async () => {
  const ctx = await setupTest();

  const image = resolveImageName('e2e-tiny');
  const open = `${ctx.prefix}iso-a`;
  const peer = `${ctx.prefix}iso-b`;

  await startV6Topology(ctx.plan);

  ctx.stack.defer(() => stopV6Topology());

  await startV6Instance(ctx.plan, 'auto');

  ctx.stack.defer(() => runDevScript('reboot'));

  await runImp('new', open, '--image', image, '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, open));

  await waitForExec(open);
  await holdImp(open);
  await runImp('new', peer, '--image', image, '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, peer));

  await waitForExec(peer);
  await holdImp(peer);

  const peerAddress = await readGuestIpv6(peer);
  const hostAddress = await readV6HostAddress();

  // a listener on the dev container, for a guest to try
  await runCommand([
    'docker',
    'exec',
    '-d',
    instance.container,
    'bun',
    '-e',
    String.raw`Bun.listen({ hostname: '::', port: 7099, socket: { open: (s) => { s.end('hi\n'); }, data: () => {} } })`,
  ]);

  // before the reboot back, while the container that runs it is there
  ctx.stack.defer(async () => {
    await runInContainer(['pkill', '-f', 'port: 7099']);
  });

  // the router, not an imp, does reach the host's port
  const fromRouter = await waitFor('the host listener', async () => {
    const result = await runCommand([
      'docker',
      'exec',
      buildV6Names(instance.container).router,
      'sh',
      '-c',
      `echo | nc -w 3 ${hostAddress} 7099`,
    ]);

    if (result.stdout.trim() !== 'hi') {
      throw new Error(`the router read ${JSON.stringify(result.stdout)}`);
    }

    return result.stdout.trim();
  });

  const toPeer = await tryGetFromImp(open, `http://[${peerAddress}]:8080/`);
  const toHost = await tryDialFromImp(open, hostAddress, 7099);
  const toLinkLocalHost = await tryDialFromImp(open, 'fe80::1%eth0', 7099);
  const toRouterNear = await tryInImp(open, `ping -c 1 -W 2 ${ctx.plan.routerNear}`);

  // the router's far side is not on a network the host is on
  const farControl = await tryInImp(open, `ping -c 1 -W 2 ${ctx.plan.routerFar}`);

  expect(fromRouter).toBe('hi');
  expect(toPeer).toBeFalse();
  expect(toHost).toBeFalse();
  expect(toLinkLocalHost).toBeFalse();
  expect(toRouterNear).toBeFalse();
  expect(farControl).toBeTrue();
});
