import { expect, onTestFinished, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, requireImp, runImp } from '../lib/imp-cli';
import { openHeldSocket, startProxy } from '../lib/imp-proxy';
import { waitForExec } from '../lib/imps';
import { instance, runChecked } from '../lib/instance';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// `imp proxy` to an imp whose agent impd records as too old to dial.

// one stack for every release, so the agent version comes back and the
// proxy stops before the imp goes
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('proxy'), stack, client };
}

test('it reports AGENT_OUTDATED and closes the connection when the imp’s agent is too old to dial', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}old`;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  ctx.stack.defer(() => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const proxy = await startProxy(name, '0:8080');

  ctx.stack.defer(async () => {
    await proxy.stop();
  });

  const imp = await requireImp(name);

  // impd reads the agent's version from the imp's vm.json for each dial
  const file = `/var/lib/imp/imps/${imp.id}/vm.json`;

  await runChecked([
    'docker',
    'exec',
    instance.container,
    'sh',
    '-c',
    `cp ${file} ${file}.e2e && sed -i 's/"agentVersion": "[^"]*"/"agentVersion": "0.1.0"/' ${file}`,
  ]);

  ctx.stack.defer(async () => {
    await runChecked(['docker', 'exec', instance.container, 'mv', `${file}.e2e`, file]);
  });

  const [port] = proxy.ports;

  invariant(port);

  const held = await openHeldSocket(port);

  ctx.stack.defer(() => {
    held.socket.destroy();
  });

  await waitFor('the AGENT_OUTDATED notice', () => {
    expect(proxy.readStderr()).toContain(`imp: ${name}:8080: AGENT_OUTDATED: `);
  });

  await held.closed;

  expect(held.socket.bytesRead).toBe(0);
});
