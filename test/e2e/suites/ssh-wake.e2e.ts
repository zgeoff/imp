import { expect, onTestFinished, test } from 'bun:test';
import { waitAwakePastIdle } from '../lib/awake-past-idle';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { assertState, createInstanceClient, readState, runImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { SSH_HOST, SSH_HOST_OTHER_KEY, runSsh, setupSshClient, startSsh } from '../lib/ssh';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// The SSH gateway and sleep: the journey waits out the idle timeout, so it
// runs in the acceptance set, not in `fast` with the ssh suite.

// one stack for every release, so ssh stops before the imp goes
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();
  const ssh = await setupSshClient();

  stack.defer(() => ssh.cleanup());

  return { prefix: readSuitePrefix('ssh-wake'), stack, client, ssh };
}

test('it wakes a sleeping imp on ssh but not on a refused login, and keeps it awake while a connection is open', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}a`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await runImp('sleep', name);

  // a refused login does not wake it
  const unknownUser = await runSsh(ctx.ssh, 'nobody', ['true']);
  const unknownKey = await runSsh(ctx.ssh, name, ['true'], { host: SSH_HOST_OTHER_KEY });
  const afterRefusals = await readState(name);

  expect(unknownUser.exitCode).toBe(255);
  expect(unknownUser.stderr).toContain('Permission denied (publickey)');
  expect(unknownKey.exitCode).toBe(255);
  expect(unknownKey.stderr).toContain('Permission denied (publickey)');
  expect(afterRefusals).toBe('sleeping');

  // a login wakes it
  const started = Date.now();

  const woken = await runSsh(ctx.ssh, name, ['echo awake']);

  writeMetric('sshWakeExecMs', Date.now() - started);

  const afterLogin = await readState(name);

  expect(woken.stdout).toBe('awake\n');
  expect(afterLogin).toBe('running');

  // an open connection keeps it awake past the idle timeout, and it sleeps
  // once the connection ends
  const held = startSsh(ctx.ssh, ['-N', `${name}@${SSH_HOST}`]);

  ctx.stack.defer(() => held.stop());

  const holding = Date.now();

  await waitAwakePastIdle(name, holding);

  await held.stop();

  // the idle timeout plus a sweep of the idle loop
  await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'), {
    timeoutMs: (config.idleTimeoutS + 15) * 1000,
  });
});
