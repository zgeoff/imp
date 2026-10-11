import { expect, onTestFinished, test } from 'bun:test';
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
import { readJailOwners } from '../lib/move-steps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// A warm move of a sleeping open imp, memory and all, between A and B on
// the harness's move network (lib/move-hosts.ts).

// one stack for every release, on both hosts
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const hosts = readMoveHosts({ tailnet: false });

  const client = await createInstanceClient();
  const clientB = await createInstanceClient(hosts.b);

  return { prefix: readSuitePrefix('moves'), stack, hosts, client, clientB };
}

test('it moves a sleeping open imp with its memory, and it reaches out at once on the target', async () => {
  const ctx = await setupTest();

  const open = `${ctx.prefix}open`;

  await runImp('new', open, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, open));

  await waitForExec(open);
  await holdImp(open);

  // a mark in tmpfs and a process that only memory holds: both survive a
  // warm move, and a cold boot loses them
  await runImp(
    'exec',
    open,
    '--',
    'sh',
    '-c',
    'echo warm-ok > /dev/shm/mark && (sleep 100000 >/dev/null 2>&1 &) && sync',
  );

  // the sleeper's pid comes first, older than the shell that runs pgrep
  const pids = await runImp('exec', open, '--', 'sh', '-c', "pgrep -f 'sleep 100000' || true");

  const [pid = ''] = pids.split('\n');

  expect(pid).not.toBe('');

  await runImp('hold', open, '0');
  await runImp('sleep', open);
  await waitFor(`${open} to sleep`, () => assertState(open, 'sleeping'));

  const out = await runImpWith({ env: ctx.hosts.cliEnv }, 'move', open, HOST_B);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.clientB, open));

  const left = await findImp(open);
  const moved = await requireImp(open, ctx.hosts.b);

  expect(out).toContain(`${open}: moved to ${HOST_B}, asleep with its memory`);
  expect(left).toBeUndefined();
  expect(moved.state).toBe('sleeping');

  // the first exec wakes it on B
  const onB = { target: ctx.hosts.b };

  const mark = await runImpWith(onB, 'exec', open, '--', 'cat', '/dev/shm/mark');

  const pidsAfter = await runImpWith(
    onB,
    'exec',
    open,
    '--',
    'sh',
    '-c',
    "pgrep -f 'sleep 100000' || true",
  );

  const [after = ''] = pidsAfter.split('\n');

  const lookup = await runImpWith(
    onB,
    'exec',
    open,
    '--',
    'sh',
    '-c',
    'nslookup example.com >/dev/null && echo dns-ok',
  );

  const fetched = await runImpWith(
    onB,
    'exec',
    open,
    '--',
    'sh',
    '-c',
    'wget -q -T 10 -O /dev/null http://example.com/ && echo http-ok',
  );

  const row = await requireImp(open, ctx.hosts.b);
  const owners = await readJailOwners(ctx.hosts.b, row.id, row.slot);

  const [uid = ''] = owners;

  expect(mark).toBe('warm-ok\n');
  expect(after).toBe(pid);
  expect(lookup).toBe('dns-ok\n');
  expect(fetched).toBe('http-ok\n');
  expect(row.coldBootReason).toBeUndefined();
  expect(Number(uid)).toBeGreaterThanOrEqual(900_000);
  expect(owners).toStrictEqual([uid, uid, uid]);
});
