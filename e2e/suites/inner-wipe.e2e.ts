import { expect, onTestFinished, test } from 'bun:test';
import { invariant } from '@impz/test-utils/invariant';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, listCheckpoints, readState, runImp, tryImp } from '../lib/imp-cli';
import { holdImp, readGuestFile, waitForExec, writeGuestFile } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';

// What a wiped user disk leaves: the agent outside the inner container
// (docs/architecture/guest/agent.md#the-inner-container) keeps answering, so a
// checkpoint restores the imp and a stop still stops it.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('inner'), stack, client };
}

test('it keeps the agent answering after rm -rf / inside, and a checkpoint restores the disk', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}rmrf`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);
  await writeGuestFile(name, '/root/marker', 'kept');
  await runImp('checkpoint', name);

  const [checkpoint] = await listCheckpoints(name);

  invariant(checkpoint);

  await tryImp(['exec', name, '--', 'sh', '-c', 'rm -rf /* 2>/dev/null']);

  // the agent answers: exec fails at once, it does not hang
  const started = Date.now();

  const broken = await tryImp(['exec', name, '--', 'true']);

  const tookMs = Date.now() - started;

  const state = await readState(name);

  expect(broken).toStrictEqual({
    exitCode: 127,
    stdout: '',
    stderr: expect.toInclude('EXEC_FAILED'),
  });

  expect(tookMs).toBeLessThan(10_000);
  expect(state).toBe('running');

  // the agent's world still runs commands, and shows the wiped disk and the
  // container's cgroup
  const left = await runImp('exec', '--agent', name, '--', 'ls', '-A', '/user');

  const events = await runImp(
    'exec',
    '--agent',
    name,
    '--',
    'cat',
    '/sys/fs/cgroup/user/cgroup.events',
  );

  expect(left.split('\n')).not.toContain('etc');
  expect(events).toContain('populated');

  await runImp('restore', name, checkpoint.id);
  await waitForExec(name);

  const marker = await readGuestFile(name, '/root/marker');

  expect(marker).toBe('kept');
});

test('it still stops and removes an imp whose disk was wiped', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}gone`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'));

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await tryImp(['exec', name, '--', 'sh', '-c', 'rm -rf /* 2>/dev/null']);
  await runImp('stop', name);

  const state = await readState(name);

  expect(state).toBe('stopped');

  const removed = await tryImp(['rm', name]);

  expect(removed.exitCode, removed.stderr).toBe(0);
});
