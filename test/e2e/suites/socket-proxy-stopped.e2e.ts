import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, runImp, runInImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { instance, runChecked } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// impd reaches Docker only through imp-docker-proxy, and only to build and
// add images: imps run without it.

// one stack for every release, so the proxy starts again before the imp goes
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('socket'), stack, client };
}

test('it keeps imps running, and answering exec, while the proxy is stopped', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}a`;
  const tiny = resolveImageName('e2e-tiny');
  const proxy = `${instance.container}-docker-proxy`;

  await runImp('new', name, '--image', tiny);

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);
  await runChecked(['docker', 'stop', proxy]);

  ctx.stack.defer(async () => {
    await runChecked(['docker', 'start', proxy]);

    await waitFor('the proxy socket again', () =>
      runChecked(['docker', 'exec', instance.container, 'docker', 'version']),
    );
  });

  const echoed = await runInImp(name, 'echo', 'still-here');
  const images = await runImp('image', 'ls');

  expect(echoed.trim()).toBe('still-here');
  expect(images).toContain(tiny);
});
