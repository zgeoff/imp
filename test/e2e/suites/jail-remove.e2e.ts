import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { assertState, createInstanceClient, requireImp, runImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { readImpdLogSince, runInContainer } from '../lib/instance';
import { findJailViolations, listJailMounts, readJailState } from '../lib/jail-host';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// A jailed VM's start, stop and removal leave no jail, cgroup or mount
// behind, nor does the boot template build a cold boot starts.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('jail'), stack, client };
}

test('it starts, stops and removes a jailed VM cleanly, and the boot template build leaves no jail mounted', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}rm`;

  // The second cold boot of a shape since impd started builds its boot
  // template in the background, unless one exists; three cold boots follow.
  const since = new Date();

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await runImp('stop', name);
  await runImp('start', name);
  await waitForExec(name);

  const started = await readJailState(name);

  expect(findJailViolations(started)).toStrictEqual([]);

  await runImp('stop', name);
  await assertState(name, 'stopped');

  const row = await requireImp(name);
  const stoppedMounts = await listJailMounts(`firecracker/${row.id}/`);

  expect(stoppedMounts).toStrictEqual([]);

  await runImp('start', name);
  await waitForExec(name);

  // a destroy kills the VM outright
  await runImp('rm', name);

  const jail = await runInContainer(['ls', `/var/lib/imp/jail/firecracker/${row.id}`]);
  const cgroup = await runInContainer(['ls', `/sys/fs/cgroup/imps/${row.id}`]);
  const removedMounts = await listJailMounts(`firecracker/${row.id}/`);

  expect(jail.exitCode).not.toBe(0);
  expect(cgroup.exitCode).not.toBe(0);
  expect(removedMounts).toStrictEqual([]);

  // impd logs a build's end: built, refused or failed; a restore of an
  // existing template starts none
  await waitFor('the boot template build to end', async () => {
    const log = await readImpdLogSince(since);

    if (
      !log.includes(`${name}: restored boot template`) &&
      !/impd: boot template [\da-f]{12} (?:built in|build refused|build failed)/v.test(log)
    ) {
      throw new Error('no build end logged yet');
    }
  });

  const mounts = await listJailMounts('');

  expect(mounts).toStrictEqual([]);
});
