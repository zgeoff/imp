import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { tryDialFromImp, tryGetFromImp, tryInImp } from '../lib/guest-probe';
import { createInstanceClient, runImp, runShellInImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { instance, runCommand, runDevScript } from '../lib/instance';
import {
  buildRaCounterTable,
  buildV6Names,
  buildV6Plan,
  readGuestIpv6,
  readHostRouting,
  readImpTap,
  readRaCounts,
  readRsAccepts,
  readV6HostAddress,
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

// Egress policies and isolation over IPv6 (docs/architecture/networking.md#ipv6),
// on the topology's near network behind NAT66. The instance reboots onto it,
// and back to its own network at the end; the checks share that one boot.

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

test('it holds box and none imps to their policies over IPv6, isolates every imp from the others and the host, drops spoofed sources, and ignores a guest’s router advertisement', async () => {
  const ctx = await setupTest();

  const image = resolveImageName('e2e-tiny');
  const open = `${ctx.prefix}open`;
  const box = `${ctx.prefix}box`;
  const none = `${ctx.prefix}none`;
  const rogue = `${ctx.prefix}ra`;
  const server = ctx.plan.server;
  const other = ctx.plan.serverOther;

  await startV6Topology(ctx.plan);

  ctx.stack.defer(() => stopV6Topology());

  await startV6Instance(ctx.plan, 'auto');

  ctx.stack.defer(() => runDevScript('reboot'));

  await runImp('new', open, '--image', image, '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, open));

  await waitForExec(open);
  await holdImp(open);

  await runImp(
    'new',
    box,
    '--image',
    image,
    '--memory',
    '256',
    '--policy',
    'box',
    '--allow',
    server,
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, box));

  await waitForExec(box);
  await holdImp(box);
  await runImp('new', none, '--image', image, '--memory', '256', '--policy', 'none');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, none));

  await waitForExec(none);
  await holdImp(none);

  // the open imp reaches each address and port, so a refusal is the policy's
  const boxToServer = await tryGetFromImp(box, `http://[${server}]/`);
  const boxToOther = await tryGetFromImp(box, `http://[${other}]/`);
  const boxToRouter = await tryGetFromImp(box, `http://[${ctx.plan.routerNear}]/`);

  // DNS goes to impd's resolver over IPv4 only; port 53 over IPv6 meets the
  // policy like any other port, so no query leaks out
  const boxLookup = await tryInImp(box, `nslookup example.com ${other}`);
  const boxToOther53 = await tryGetFromImp(box, `http://[${other}]:53/`);
  const boxToServer53 = await tryGetFromImp(box, `http://[${server}]:53/`);
  const openToOther = await tryGetFromImp(open, `http://[${other}]/`);
  const openToOther53 = await tryGetFromImp(open, `http://[${other}]:53/`);
  const noneReached = await tryGetFromImp(none, `http://[${server}]/`);

  expect(boxToServer).toBeTrue();
  expect(boxToOther).toBeFalse();
  expect(boxToRouter).toBeFalse();
  expect(boxLookup).toBeFalse();
  expect(boxToOther53).toBeFalse();
  expect(boxToServer53).toBeTrue();
  expect(openToOther).toBeTrue();
  expect(openToOther53).toBeTrue();
  expect(noneReached).toBeFalse();

  const boxAddress = await readGuestIpv6(box);
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

  const toBox = await tryGetFromImp(open, `http://[${boxAddress}]:8080/`);
  const toHost = await tryDialFromImp(open, hostAddress, 7099);
  const toLinkLocalHost = await tryDialFromImp(open, 'fe80::1%eth0', 7099);
  const toRouterNear = await tryInImp(open, `ping -c 1 -W 2 ${ctx.plan.routerNear}`);

  // the router's far side is not on a network the host is on
  const farControl = await tryInImp(open, `ping -c 1 -W 2 ${ctx.plan.routerFar}`);

  expect(fromRouter).toBe('hi');
  expect(toBox).toBeFalse();
  expect(toHost).toBeFalse();
  expect(toLinkLocalHost).toBeFalse();
  expect(toRouterNear).toBeFalse();
  expect(farControl).toBeTrue();

  // Spoofed from outside the prefix, and as another imp: the host's rpfilter
  // drops both before the slot chain's own source check
  const own = await readGuestIpv6(open);

  const farSpoof = `${ctx.plan.far}77`;

  // before the spoofed addresses, which the guest would pick as its source
  const spoofControl = await tryDialFromImp(open, server, 80);

  await runShellInImp(
    open,
    [
      'echo 0 > /proc/sys/net/ipv6/conf/eth0/accept_dad',
      `ip -6 addr add ${farSpoof}/128 dev eth0`,
      `ip -6 addr add ${boxAddress}/128 dev eth0`,
    ].join(' && '),
  );

  const fromOwn = await tryDialFromImp(open, server, 80, own);
  const fromFar = await tryDialFromImp(open, server, 80, farSpoof);
  const fromBox = await tryDialFromImp(open, server, 80, boxAddress);

  expect(spoofControl).toBeTrue();
  expect(fromOwn).toBeTrue();
  expect(fromFar).toBeFalse();
  expect(fromBox).toBeFalse();

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
