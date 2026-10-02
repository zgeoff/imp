import { afterAll, beforeAll, expect, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { assertState } from '../lib/imp-cli';
import { createImp } from '../lib/imps';
import { setupSuite } from '../lib/setup-suite';
import { SSH_HOST, SSH_HOST_OTHER_KEY, runSsh, setupSshClient, startSsh } from '../lib/ssh';
import type { SshClient } from '../lib/ssh';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// The SSH gateway and sleep: each case waits out the idle timeout, so these
// run in the acceptance set, not in `fast` with the ssh suite.

const prefix = setupSuite('ssh-wake');
const name = `${prefix}a`;

// the idle timeout plus a sweep of the idle loop
const ASLEEP_WITHIN_MS = (config.idleTimeoutS + 15) * 1000;

// long enough that only activity keeps an imp awake
const PAST_IDLE_MS = (config.idleTimeoutS + 6) * 1000;
let client: SshClient;

beforeAll(async () => {
  client = await setupSshClient();

  await createImp(name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');
}, 120_000);

afterAll(async () => {
  await client.cleanup();
});

function waitAsleep(): Promise<void> {
  return waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'), {
    timeoutMs: ASLEEP_WITHIN_MS,
  });
}

test('a refused login does not wake a sleeping imp', async () => {
  await waitAsleep();

  const unknownUser = await runSsh(client, 'nobody', ['true']);
  const unknownKey = await runSsh(client, name, ['true'], { host: SSH_HOST_OTHER_KEY });

  for (const result of [unknownUser, unknownKey]) {
    expect(result.exitCode).toBe(255);
    expect(result.stderr).toContain('Permission denied (publickey)');
  }

  await assertState(name, 'sleeping');
});

test('ssh wakes a sleeping imp', async () => {
  await assertState(name, 'sleeping');

  const started = Date.now();

  const result = await runSsh(client, name, ['echo awake']);

  writeMetric('sshWakeExecMs', Date.now() - started);

  expect(result.stdout).toBe('awake\n');

  await assertState(name, 'running');
});

test('an open connection keeps the imp awake, and it sleeps once the connection ends', async () => {
  const held = startSsh(client, ['-N', `${name}@${SSH_HOST}`]);

  try {
    await Bun.sleep(PAST_IDLE_MS);

    await assertState(name, 'running');
  } finally {
    await held.stop();
  }

  await waitAsleep();
});
