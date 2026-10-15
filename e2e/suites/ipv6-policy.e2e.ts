import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { tryGetFromImp, tryInImp } from '../lib/guest-probe';
import { createInstanceClient, runImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { instance, runDevScript } from '../lib/instance';
import {
  buildV6Plan,
  startV6Instance,
  startV6Topology,
  stopV6Topology,
} from '../lib/ipv6-topology';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';

// Egress policies over IPv6 (docs/architecture/network/networking.md#ipv6), on the
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

test('it holds box and none imps to their policies over IPv6, while an open imp reaches each address', async () => {
  const ctx = await setupTest();

  const image = resolveImageName('e2e-tiny');
  const open = `${ctx.prefix}open`;
  const box = `${ctx.prefix}box`;
  const none = `${ctx.prefix}none`;
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
});
