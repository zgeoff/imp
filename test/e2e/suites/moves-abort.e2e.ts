import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { assertState, createInstanceClient, findImp, runImp, runImpWith } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { HOST_B, readMoveHosts } from '../lib/move-hosts';
import { startMoveSend } from '../lib/move-steps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// A move's first step, then the abort a user picks, between A and B on the
// harness's move network (lib/move-hosts.ts).

// one stack for every release, on both hosts
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = readMoveHosts({ tailnet: false });

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('moves'), stack, hosts, client };
}

test('it leaves an imp where it was on an abort after the source marked it', async () => {
  const ctx = await setupTest();

  const kept = `${ctx.prefix}kept`;

  await runImp('new', kept, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, kept));

  await waitForExec(kept);
  await runImp('stop', kept);
  await startMoveSend(ctx.hosts.a, kept);

  const out = await runImpWith({ env: ctx.hosts.cliEnv }, 'move', kept, HOST_B, '--abort');
  const onTarget = await findImp(kept, ctx.hosts.b);

  expect(out).toContain('move aborted; it stays here');
  expect(onTarget).toBeUndefined();

  await runImp('start', kept);
  await waitFor(`${kept} to boot on A`, () => assertState(kept, 'running'));
});
