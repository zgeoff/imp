import { expect, onTestFinished, test } from 'bun:test';
import { waitForShapeTemplate } from '../lib/boot-template-guest';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { tryGetFromImp } from '../lib/guest-probe';
import { createInstanceClient, requireImp, runImp, runShellInImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { instance, readImpdLogSince, runDevScript } from '../lib/instance';
import {
  buildGuestIpv6,
  buildV6Plan,
  parseUlaNetwork,
  readGuestIpv6,
  readV6HostAddress,
  startV6Instance,
  startV6Topology,
  stopV6Topology,
} from '../lib/ipv6-topology';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';

// IPv6 for imps (docs/architecture/network/networking.md#ipv6) behind NAT66: the
// instance reboots onto the topology's near network with a ULA /64, and
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

test('it gives an imp a /128 in the ULA prefix, from a boot template claim too, and reaches hosts beyond the host behind NAT66 through a narrower network, before and after a sleep', async () => {
  const ctx = await setupTest();

  const image = resolveImageName('e2e-tiny');
  const open = `${ctx.prefix}open`;
  const spare = `${ctx.prefix}spare`;
  const restored = `${ctx.prefix}tpl`;

  await startV6Topology(ctx.plan);

  ctx.stack.defer(() => stopV6Topology());

  const started = new Date();

  await startV6Instance(ctx.plan, 'auto');

  ctx.stack.defer(() => runDevScript('reboot'));

  await runImp('new', open, '--image', image, '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, open));

  await waitForExec(open);
  await holdImp(open);

  const log = await readImpdLogSince(started);

  const network = parseUlaNetwork(log);

  const openRow = await requireImp(open);
  const address = await readGuestIpv6(open);
  const routes = await runShellInImp(open, 'ip -6 route');

  expect(address).toBe(buildGuestIpv6(network, openRow.ip));
  expect(routes).toContain('default via fe80::1 dev eth0');

  // the shape's second boot builds its template, unless one exists
  await runImp('new', spare, '--image', image, '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, spare));

  await waitForExec(spare);
  await runImp('rm', spare);
  await waitForShapeTemplate(256);

  const claimed = new Date();

  await runImp('new', restored, '--image', image, '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, restored));

  await waitForExec(restored);

  const claimLog = await readImpdLogSince(claimed);
  const restoredRow = await requireImp(restored);
  const restoredAddress = await readGuestIpv6(restored);

  expect(claimLog).toContain(`${restored}: restored boot template`);
  expect(restoredAddress).toBe(buildGuestIpv6(network, restoredRow.ip));

  const hostAddress = await readV6HostAddress();
  const page = await runShellInImp(open, `wget -q -T 10 -O- http://[${ctx.plan.server}]/`);

  const peer = await runShellInImp(
    open,
    `wget -q -T 10 -O- http://[${ctx.plan.server}]/cgi-bin/peer`,
  );

  expect(page).toBe('v6-ok');
  expect(peer).toBe(`[${hostAddress}]`);

  // the router beyond the host refuses the guest's full segments, and the
  // host must let its packet-too-big through; httpd hands a CGI no NUL bytes
  const uploaded = await runShellInImp(
    open,
    [
      String.raw`head -c 524288 /dev/zero | tr '\0' a > /tmp/up`,
      `wget -q -T 20 -O- --post-file=/tmp/up http://[${ctx.plan.server}]/cgi-bin/upload`,
    ].join(' && '),
  );

  const tooBig = await runShellInImp(open, 'grep Icmp6InPktTooBigs /proc/net/snmp6');

  const size = await runShellInImp(
    open,
    `wget -q -T 20 -O- http://[${ctx.plan.server}]/big | wc -c`,
  );

  expect(uploaded.trim()).toBe('524288');
  expect(Number(tooBig.split(/\s+/v).at(-1))).toBeGreaterThan(0);
  expect(size.trim()).toBe('2097152');

  await runImp('sleep', open);
  await waitForExec(open);

  const afterSleep = await readGuestIpv6(open);
  const reached = await tryGetFromImp(open, `http://[${ctx.plan.server}]/`);

  expect(afterSleep).toBe(address);
  expect(reached).toBeTrue();
});
