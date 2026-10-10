import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, runImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { instance, runDevScript } from '../lib/instance';
import {
  findJailViolations,
  readJailState,
  readStatusField,
  readVmProcess,
} from '../lib/jail-host';
import { checkMemoryProof, startMemoryProof } from '../lib/memory-proof';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';

// A rollback to an impd without the jailer, then the upgrade back: each
// reboot sleeps the imp in the old impd. The journey ends on the run's
// settings; after a failure, the harness reboots onto them.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('jail'), stack, client };
}

test('it wakes a jailed snapshot as root in an impd without the jailer, and that snapshot jailed again after the upgrade', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}roll`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const proof = await startMemoryProof(name);

  await runDevScript('reboot', instance, { IMP_JAILER: 'false' });
  await runImp('wake', name);
  await waitForExec(name);
  await checkMemoryProof(proof);

  const rolledBack = await readVmProcess(name);

  expect(rolledBack.cmdline).not.toContain('--id');
  expect(readStatusField(rolledBack.status, 'Uid').split(/\s+/v)[0]).toBe('0');

  await runDevScript('reboot');
  await runImp('wake', name);
  await waitForExec(name);
  await checkMemoryProof(proof);

  const upgraded = await readJailState(name);

  expect(findJailViolations(upgraded)).toStrictEqual([]);
});
