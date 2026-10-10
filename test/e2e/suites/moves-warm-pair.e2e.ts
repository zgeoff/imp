import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { assertState, createInstanceClient, requireImp, runImp, runImpWith } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { HOST_B, readMoveHosts } from '../lib/move-hosts';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// A warm move keeps the imp's slot, so two warm imps that live on A side by
// side, in slots of their own, live on B side by side too (lib/move-hosts.ts).

// one stack for every release, on both hosts
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = readMoveHosts({ tailnet: false });

  const client = await createInstanceClient();
  const clientB = await createInstanceClient(hosts.b);

  return { prefix: readSuitePrefix('moves'), stack, hosts, client, clientB };
}

test('it moves two sleeping imps from slots of their own on A onto B side by side, and both wake there', async () => {
  const ctx = await setupTest();

  const first = `${ctx.prefix}pair1`;
  const second = `${ctx.prefix}pair2`;

  await runImp('new', first, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, first));

  await runImp('new', second, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, second));

  await waitForExec(first);
  await waitForExec(second);

  const firstOnA = await requireImp(first);
  const secondOnA = await requireImp(second);

  await runImp('sleep', first);
  await runImp('sleep', second);
  await waitFor(`${first} to sleep`, () => assertState(first, 'sleeping'));
  await waitFor(`${second} to sleep`, () => assertState(second, 'sleeping'));

  const firstOut = await runImpWith({ env: ctx.hosts.cliEnv }, 'move', first, HOST_B);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.clientB, first));

  const secondOut = await runImpWith({ env: ctx.hosts.cliEnv }, 'move', second, HOST_B);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.clientB, second));

  const firstMoved = await requireImp(first, ctx.hosts.b);
  const secondMoved = await requireImp(second, ctx.hosts.b);

  // the first exec wakes each on B, while the other is there too
  const onB = { target: ctx.hosts.b };

  const firstSaid = await runImpWith(onB, 'exec', first, '--', 'echo', 'pair1-ok');
  const secondSaid = await runImpWith(onB, 'exec', second, '--', 'echo', 'pair2-ok');
  const firstAwake = await requireImp(first, ctx.hosts.b);
  const secondAwake = await requireImp(second, ctx.hosts.b);

  expect(firstOnA.slot).not.toBe(secondOnA.slot);
  expect(firstOut).toContain(`${first}: moved to ${HOST_B}, asleep with its memory`);
  expect(secondOut).toContain(`${second}: moved to ${HOST_B}, asleep with its memory`);
  expect(firstMoved.state).toBe('sleeping');
  expect(secondMoved.state).toBe('sleeping');
  expect(firstMoved.slot).toBe(firstOnA.slot);
  expect(secondMoved.slot).toBe(secondOnA.slot);
  expect(firstSaid).toBe('pair1-ok\n');
  expect(secondSaid).toBe('pair2-ok\n');
  expect(firstAwake.state).toBe('running');
  expect(secondAwake.state).toBe('running');
  expect(firstAwake.coldBootReason).toBeUndefined();
  expect(secondAwake.coldBootReason).toBeUndefined();
});
