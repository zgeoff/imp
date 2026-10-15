import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import {
  assertState,
  createInstanceClient,
  findImp,
  requireImp,
  runImp,
  runImpWith,
  tryImp,
} from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { HOST_B, readMoveHosts } from '../lib/move-hosts';
import { writeBothHostsConfig } from '../lib/move-steps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// `impz new --place` across A and B on the harness's move network
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

test('it creates on the saved host with the most free RAM for impz new --place', async () => {
  const ctx = await setupTest();

  const seed = `${ctx.prefix}seed`;
  const filler = `${ctx.prefix}filler`;
  const placed = `${ctx.prefix}placed`;

  const configDir = await mkdtemp(join(tmpdir(), 'imp-mv-both-'));

  ctx.stack.defer(() => rm(configDir, { recursive: true, force: true }));

  const bothEnv = await writeBothHostsConfig(ctx.hosts, configDir);

  // a cold move gives B the tiny image, so only the room tells the two hosts
  // apart; without it the tie would go to A, first by name
  await runImp('new', seed, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, seed));

  await waitForExec(seed);
  await runImp('stop', seed);
  await runImpWith({ env: ctx.hosts.cliEnv }, 'move', seed, HOST_B);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.clientB, seed));

  await runImpWith({ target: ctx.hosts.b }, 'rm', seed);

  // A's sleeper counts its whole memory as taken, which leaves A less free
  // RAM than B
  await runImp('new', filler, '--image', resolveImageName('e2e-tiny'), '--memory', '1024');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, filler));

  await waitForExec(filler);
  await runImp('sleep', filler);
  await waitFor(`${filler} to sleep`, () => assertState(filler, 'sleeping'));

  const result = await tryImp(
    [
      'new',
      placed,
      '--place',
      '--image',
      resolveImageName('e2e-tiny'),
      '--memory',
      '256',
      '--json',
    ],
    { env: bothEnv },
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.clientB, placed));
  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, placed));

  const onA = await findImp(placed);
  const onB = await requireImp(placed, ctx.hosts.b);

  expect(result).toStrictEqual({
    exitCode: 0,
    stdout: expect.toBeString(),
    stderr: expect.toInclude(`impz: placing on ${HOST_B}`),
  });

  expect(result.stderr).not.toContain('skipped');

  // what `impz new --place --json` prints, in part
  const printed: unknown = JSON.parse(result.stdout);
  const body = z.object({ host: z.string(), imp: z.object({ name: z.string() }) }).parse(printed);

  expect(body).toStrictEqual({ host: HOST_B, imp: { name: placed } });
  expect(onA).toBeUndefined();
  expect(onB.name).toBe(placed);
});
