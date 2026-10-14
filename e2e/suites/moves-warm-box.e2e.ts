import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import {
  assertState,
  createInstanceClient,
  findImp,
  requireImp,
  runImp,
  runImpWith,
} from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { HOST_B, readMoveHosts } from '../lib/move-hosts';
import { buildUpstreamsPath, readAllowSet, writeUpstreamsFile } from '../lib/move-steps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent, removeSecretIfPresent } from '../lib/reset-baseline';
import { startStubUpstream } from '../lib/start-stub-upstream';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// A warm move of a sleeping box imp with a granted secret, between A and B
// on the harness's move network (lib/move-hosts.ts); the stub upstream for
// api.github.com checks B's token, so it tells which broker sent a call.

// one stack for every release, on both hosts
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = readMoveHosts({ tailnet: false });

  const client = await createInstanceClient();
  const clientB = await createInstanceClient(hosts.b);

  return { prefix: readSuitePrefix('moves'), stack, hosts, client, clientB };
}

test('it moves a sleeping box imp with its allow list, and the target’s broker answers right after the wake', async () => {
  const ctx = await setupTest();

  const box = `${ctx.prefix}box`;
  const secret = `${ctx.prefix}gh`;

  // each host's broker holds its own token for the secret
  const tokenA = `e2e-a-${randomUUID()}`;
  const tokenB = `e2e-b-${randomUUID()}`;

  const upstream = await startStubUpstream(ctx.hosts.gateway, tokenB);

  ctx.stack.defer(() => upstream.stop());

  await writeUpstreamsFile(ctx.hosts.a, upstream);

  ctx.stack.defer(() => rm(buildUpstreamsPath(ctx.hosts.a), { force: true }));

  await writeUpstreamsFile(ctx.hosts.b, upstream);

  ctx.stack.defer(() => rm(buildUpstreamsPath(ctx.hosts.b), { force: true }));

  await runImpWith({ stdin: `${tokenA}\n` }, 'secret', 'add', secret, '--kind', 'github');

  registerRemoval(ctx.stack, config.keep, () => removeSecretIfPresent(ctx.client, secret));

  await runImpWith(
    { target: ctx.hosts.b, stdin: `${tokenB}\n` },
    'secret',
    'add',
    secret,
    '--kind',
    'github',
  );

  registerRemoval(ctx.stack, config.keep, () => removeSecretIfPresent(ctx.clientB, secret));

  await runImp(
    'new',
    box,
    '--image',
    resolveImageName('base'),
    '--memory',
    '1g',
    '--policy',
    'box',
    '--allow',

    // B resolves only the exact names at create: a wildcard's addresses on B
    // can only have come from A's lookups
    'example.com,api.github.com,github.com,*.wikipedia.org',
  );

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, box));

  await waitForExec(box);
  await runImp('grant', box, secret);
  await holdImp(box);

  // a mark in tmpfs and a process that only memory holds: both survive a
  // warm move, and a cold boot loses them
  await runImp(
    'exec',
    box,
    '--',
    'sh',
    '-c',
    'echo warm-ok > /dev/shm/mark && (sleep 100000 >/dev/null 2>&1 &) && sync',
  );

  // the sleeper's pid comes first, older than the shell that runs pgrep
  const pids = await runImp('exec', box, '--', 'sh', '-c', "pgrep -f 'sleep 100000' || true");

  const [pid = ''] = pids.split('\n');

  // a lookup on A under the wildcard, whose answer only the move can carry
  // into B's set for the slot
  await runImp('exec', box, '--', 'getent', 'hosts', 'en.wikipedia.org');

  const onA = await requireImp(box);
  const before = await readAllowSet(ctx.hosts.a, onA.slot);

  await runImp('hold', box, '0');
  await runImp('sleep', box);
  await waitFor(`${box} to sleep`, () => assertState(box, 'sleeping'));

  const out = await runImpWith({ env: ctx.hosts.cliEnv }, 'move', box, HOST_B);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.clientB, box));

  const left = await findImp(box);
  const moved = await requireImp(box, ctx.hosts.b);

  expect(pid).not.toBe('');
  expect(out).toContain(`${box}: moved to ${HOST_B}, asleep with its memory`);
  expect(left).toBeUndefined();
  expect(moved.state).toBe('sleeping');

  // read before the guest can look anything up again on B
  const held = await readAllowSet(ctx.hosts.b, onA.slot);

  // the broker call first: the target installs its CA at the first wake
  const onB = { target: ctx.hosts.b };

  const body = await runImpWith(
    onB,
    'exec',
    box,
    '--',
    'curl',
    '-sS',
    '--fail',
    'https://api.github.com/user',
  );

  const mark = await runImpWith(onB, 'exec', box, '--', 'cat', '/dev/shm/mark');

  const pidsAfter = await runImpWith(
    onB,
    'exec',
    box,
    '--',
    'sh',
    '-c',
    "pgrep -f 'sleep 100000' || true",
  );

  const [after = ''] = pidsAfter.split('\n');

  const allowed = await runImpWith(
    onB,
    'exec',
    box,
    '--',
    'curl',
    '-sS',
    '-o',
    '/dev/null',
    '-w',
    '%{http_code}',
    '--max-time',
    '10',
    'http://example.com/',
  );

  const refused = await runImpWith(
    onB,
    'exec',
    box,
    '--',
    'sh',
    '-c',
    'curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://example.org/ || true',
  );

  expect(before).not.toBeEmpty();
  expect(held).toIncludeAllMembers(before);
  expect(JSON.parse(body)).toStrictEqual({ authorized: true });
  expect(upstream.seen.at(-1)?.authorization).toBe(`Bearer ${tokenB}`);
  expect(mark).toBe('warm-ok\n');
  expect(after).toBe(pid);
  expect(allowed).toBe('200');
  expect(refused).toBe('000');
});
