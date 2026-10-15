import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, runImp, runInImp, runShellInImp, tryImp } from '../lib/imp-cli';
import { holdImp, waitForExec, writeGuestFile } from '../lib/imps';
import { readInitStart } from '../lib/inner-container';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';

// User code runs in the inner container over the user disk; the agent stays
// outside it (docs/architecture/guest/agent.md#the-inner-container). Nothing done
// inside may take the agent down. Each test boots its own imp.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('inner'), stack, client };
}

test('it runs the inner init as PID 1 of what an exec sees, from the system drive', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}pid1`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const cmdline = await runShellInImp(name, String.raw`tr '\0' ' ' < /proc/1/cmdline`);
  const agent = await runShellInImp(name, 'test -x /run/imp/sys/imp-agent && echo ok');

  expect(cmdline.trim()).toBe('/imp-agent inner');
  expect(agent).toBe('ok');
});

test('it leaves the inner init socket held by no process inside', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}sock`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const own = await runShellInImp(name, String.raw`ls /proc/self/fd | tr "\n" " "`);
  const socket = await runShellInImp(name, 'readlink /proc/1/fd/3');

  // the httpd service, and everything else, has no fd on the init's socket
  const holders = await runShellInImp(
    name,
    `for p in /proc/[0-9]*; do [ "$p" = /proc/1 ] || ls -l "$p/fd" 2>/dev/null; done | grep -c '${socket}' || true`,
  );

  // ls's own fd 3 is its directory
  expect(own.trim()).toBe('0 1 2 3');
  expect(socket).toStartWith('socket:');
  expect(holders).toBe('0');
});

test('it lets a memory hog inside meet the OOM killer while the container stays up', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}oom`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const before = await readInitStart(name);
  const adj = await runShellInImp(name, 'cat /proc/self/oom_score_adj');
  const hog = await tryImp(['exec', name, '--', 'awk', 'BEGIN { s = "x"; while (1) s = s s }']);

  await waitForExec(name);

  const after = await readInitStart(name);

  expect(adj).toBe('0');
  expect(hog.exitCode).toBe(137);
  expect(after).toBe(before);
});

test("it keeps the system drive read-only inside, and the agent's /run out of it", async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}ro`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const write = await tryImp(['exec', name, '--', 'touch', '/run/imp/sys/x']);
  const runs = await runShellInImp(name, "grep -c ' /run ' /proc/mounts");

  const agentRun = await runShellInImp(
    name,
    "grep ' /run ' /proc/mounts | grep -c size=16384k || true",
  );

  expect(write).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'touch: /run/imp/sys/x: Read-only file system\n',
  });

  expect(runs).toBe('1');
  expect(agentRun).toBe('0');
});

test('it gives an exec its cgroup even after the exec parent is removed inside', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}cg`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  await runShellInImp(
    name,
    [
      // out of its own leaf first, which would keep the parent busy
      'echo $$ > /sys/fs/cgroup/init/cgroup.procs',
      'rmdir /sys/fs/cgroup/exec/* 2>/dev/null',
      'rmdir /sys/fs/cgroup/exec',
    ].join('\n'),
  );

  const cgroup = await runInImp(name, 'cat', '/proc/self/cgroup');

  expect(cgroup).toMatch(/^0::\/exec\/\d+$/v);
});

test('it ignores signals to PID 1 from inside', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}sig`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const before = await readInitStart(name);

  await runShellInImp(name, 'for s in TERM SEGV INT HUP QUIT ABRT USR1; do kill -$s 1; done');

  const after = await readInitStart(name);

  expect(after).toBe(before);
});

test('it keeps the container up through kill -9 -1 inside', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}kill`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const before = await readInitStart(name);

  await tryImp(['exec', name, '--', 'sh', '-c', 'kill -9 -1']);
  await waitForExec(name);

  const after = await readInitStart(name);

  expect(after).toBe(before);
});

test('it removes device nodes removed inside only inside, and execs still run', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}dev`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);
  await runShellInImp(name, 'rm -f /dev/null /dev/zero');

  // the agent opens its own /dev/null for every exec's stdin
  const seen = await runShellInImp(name, 'test -e /dev/null || echo gone');

  expect(seen).toBe('gone');
});

test('it copies out with impz cp while the system drive is unmounted inside', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}cp`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);
  await writeGuestFile(name, '/root/copied', 'through-the-agent-fd');
  await runInImp(name, 'umount', '/run/imp/sys');

  const local = await mkdtemp(join(tmpdir(), 'imp-e2e-inner-'));

  ctx.stack.defer(() => rm(local, { recursive: true, force: true }));

  await runImp('cp', `${name}:/root/copied`, local);

  const copied = await readFile(join(local, 'copied'), 'utf8');

  expect(copied.trim()).toBe('through-the-agent-fd');
});
