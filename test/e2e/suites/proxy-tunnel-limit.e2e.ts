import { expect, onTestFinished, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, runImp } from '../lib/imp-cli';
import { PAGE, countMatches, openHeldSocket, readPage, startProxy } from '../lib/imp-proxy';
import type { HeldSocket } from '../lib/imp-proxy';
import { waitForExec } from '../lib/imps';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';

// `imp proxy` against impd's cap on open tunnels per imp.

// one stack for every release, so the held connections close and the proxy
// stops before the imp goes
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('proxy'), stack, client };
}

test('it refuses the connection past the tunnel cap with TUNNEL_LIMIT, and opens a tunnel again once the held ones close', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}cap`;

  // impd's cap on open tunnels per imp
  const maxTunnels = 256;

  await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

  ctx.stack.defer(() => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const proxy = await startProxy(name, '0:8080');

  ctx.stack.defer(async () => {
    await proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port);

  const held: HeldSocket[] = [];

  ctx.stack.defer(() => {
    for (const entry of held) {
      entry.socket.destroy();
    }
  });

  for (let index = 0; index <= maxTunnels; index++) {
    const socket = await openHeldSocket(port);

    held.push(socket);
  }

  // the proxy writes the notice, then closes the refused connection; on a
  // fresh imp, one past the cap leaves room for no second refusal
  await Promise.race(held.map((entry) => entry.closed));

  const refused = held.filter((entry) => entry.socket.destroyed);
  const notices = countMatches(proxy.readStderr(), 'TUNNEL_LIMIT');

  for (const entry of held) {
    entry.socket.destroy();
  }

  const page = await waitFor('a tunnel after the held ones closed', () =>
    readPage(`http://127.0.0.1:${String(port)}/`),
  );

  expect(refused).toHaveLength(1);
  expect(notices).toBe(1);
  expect(page).toBe(PAGE);
});
