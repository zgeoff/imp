import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveImageName } from '../lib/fixtures';
import {
  listCheckpoints,
  readState,
  runImp,
  runInImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { createImp, holdImp, readGuestFile, waitForExec, writeGuestFile } from '../lib/imps';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

// User code runs in the inner container over the user disk; the agent stays
// outside it (docs/architecture/agent.md#the-inner-container). Nothing done
// inside may take the agent down.
const prefix = setupSuite('inner');
const TINY = resolveImageName('e2e-tiny');
const name = `${prefix}a`;

// the inner init's start time, in clock ticks since boot: it changes only
// when the container starts again
function readInitStart(): Promise<string> {
  return runShellInImp(name, "cut -d' ' -f22 /proc/1/stat");
}

// the guest's uptime in whole seconds, which a container restart keeps
async function readUptime(): Promise<number> {
  const uptime = await runShellInImp(name, 'cut -d. -f1 /proc/uptime');

  return Number(uptime);
}

async function waitForInit(): Promise<void> {
  await waitFor(`the inner container in ${name}`, () => runInImp(name, 'true'), {
    timeoutMs: 30_000,
  });
}

test('the inner init is PID 1 of what an exec sees', async () => {
  await createImp(name, '--image', TINY);
  await holdImp(name);

  const cmdline = await runShellInImp(name, String.raw`tr '\0' ' ' < /proc/1/cmdline`);

  expect(cmdline.trim()).toBe('/imp-agent inner');

  const agent = await runShellInImp(name, 'test -x /run/imp/sys/imp-agent && echo ok');

  expect(agent).toBe('ok');
});

test('signals to PID 1 from inside are ignored', async () => {
  const before = await readInitStart();

  for (const signal of ['TERM', 'SEGV', 'INT', 'HUP', 'QUIT', 'ABRT', 'USR1']) {
    await runShellInImp(name, `kill -${signal} 1`);
  }

  const after = await readInitStart();

  expect(after).toBe(before);
});

test('kill -9 -1 inside leaves the container up', async () => {
  const before = await readInitStart();

  await tryImp(['exec', name, '--', 'sh', '-c', 'kill -9 -1']);
  await waitForExec(name);

  const after = await readInitStart();

  expect(after).toBe(before);
});

test('device nodes removed inside are gone only inside', async () => {
  await runShellInImp(name, 'rm -f /dev/null /dev/zero');

  // the agent opens its own /dev/null for every exec's stdin
  const seen = await runShellInImp(name, 'test -e /dev/null || echo gone');

  expect(seen).toBe('gone');
});

test('a reboot inside starts the container again, not the guest', async () => {
  await writeGuestFile(name, '/root/marker', 'kept');

  const before = await readInitStart();
  const uptimeBefore = await readUptime();

  // busybox reboot -f calls reboot(2), which in a PID namespace kills its init
  await tryImp(['exec', name, '--', 'reboot', '-f']);
  await waitForInit();

  const after = await readInitStart();
  const marker = await readGuestFile(name, '/root/marker');
  const devNull = await runShellInImp(name, 'test -c /dev/null && echo back');
  const uptimeAfter = await readUptime();

  expect(after).not.toBe(before);
  expect(marker).toBe('kept');
  expect(devNull).toBe('back');
  expect(uptimeAfter).toBeGreaterThanOrEqual(uptimeBefore);
});

test('imp cp works with the system drive unmounted inside', async () => {
  await writeGuestFile(name, '/root/copied', 'through-the-agent-fd');
  await runInImp(name, 'umount', '/run/imp/sys');

  const local = mkdtempSync(join(tmpdir(), 'imp-e2e-inner-'));

  await runImp('cp', `${name}:/root/copied`, local);

  expect(readFileSync(join(local, 'copied'), 'utf8').trim()).toBe('through-the-agent-fd');
});

test('rm -rf / inside leaves the agent answering and a checkpoint restores it', async () => {
  await runImp('checkpoint', name);

  const [checkpoint] = await listCheckpoints(name);

  if (checkpoint === undefined) {
    throw new Error(`${name} has no checkpoint`);
  }

  await tryImp(['exec', name, '--', 'sh', '-c', 'rm -rf /* 2>/dev/null']);

  // the agent answers: exec fails at once, it does not hang
  const started = Date.now();

  const broken = await tryImp(['exec', name, '--', 'true']);

  const tookMs = Date.now() - started;

  const state = await readState(name);

  expect(broken.exitCode).not.toBe(0);
  expect(tookMs).toBeLessThan(10_000);
  expect(state).toBe('running');

  await runImp('restore', name, checkpoint.id);
  await waitForExec(name);

  const marker = await readGuestFile(name, '/root/marker');

  expect(marker).toBe('kept');
});

test('an imp whose disk was wiped still stops and goes', async () => {
  await tryImp(['exec', name, '--', 'sh', '-c', 'rm -rf /* 2>/dev/null']);
  await runImp('stop', name);

  const state = await readState(name);

  expect(state).toBe('stopped');

  await runImp('rm', name);
});
