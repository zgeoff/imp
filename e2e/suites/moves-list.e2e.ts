import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, runImp, runImpWith } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { HOST_B, readMoveHosts } from '../lib/move-hosts';
import { HOST_A, listAllHosts, startMoveSend, writeBothHostsConfig } from '../lib/move-steps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';

// `impz ls --all` across A and B on the harness's move network
// (lib/move-hosts.ts), with both saved in a CLI config of the test's own.

// one stack for every release, on both hosts
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = readMoveHosts({ tailnet: false });

  const client = await createInstanceClient();
  const clientB = await createInstanceClient(hosts.b);

  return { prefix: readSuitePrefix('moves'), stack, hosts, client, clientB };
}

test('it shows both hosts in impz ls --all, with the move mark while the imp moves', async () => {
  const ctx = await setupTest();

  const seen = `${ctx.prefix}seen`;

  // the move config keeps B alone, so the listing gets one of its own
  const configDir = await mkdtemp(join(tmpdir(), 'imp-mv-both-'));

  ctx.stack.defer(() => rm(configDir, { recursive: true, force: true }));

  const bothEnv = await writeBothHostsConfig(ctx.hosts, configDir);

  await runImp('new', seen, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, seen));

  await waitForExec(seen);
  await runImp('stop', seen);
  await startMoveSend(ctx.hosts.a, seen);

  const during = await listAllHosts(bothEnv, seen);

  expect(during.imps.map((imp) => [imp.host, imp.move])).toStrictEqual([[HOST_A, 'sending']]);
  expect(during.rows).toHaveLength(1);
  expect(during.rows[0]).toStartWith(`${HOST_A} `);
  expect(during.rows[0]).toContain(' sending');

  await runImpWith({ env: ctx.hosts.cliEnv }, 'move', seen, HOST_B, '--abort');
  await runImpWith({ env: ctx.hosts.cliEnv }, 'move', seen, HOST_B);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.clientB, seen));

  const after = await listAllHosts(bothEnv, seen);

  expect(after.imps.map((imp) => [imp.host, imp.move])).toStrictEqual([[HOST_B, undefined]]);
  expect(after.rows).toHaveLength(1);
  expect(after.rows[0]).toStartWith(`${HOST_B} `);
  expect(after.rows[0]).not.toContain('sending');
});
