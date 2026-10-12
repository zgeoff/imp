import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { sendProxyRequest } from '../lib/http';
import { createInstanceClient, runImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { openProxySocket } from '../lib/websocket';

// What the wake proxy answers when no imp, or nothing in an awake imp, can
// take the request (docs/architecture/networking.md#the-wake-proxy).

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('sleep'), stack, client };
}

test('it answers 404 for an unknown imp, and 502 when nothing in the imp listens', async () => {
  const ctx = await setupTest();

  // e2e-bare serves nothing on the imp's http port
  const name = `${ctx.prefix}quiet`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const unknown = await sendProxyRequest(`${ctx.prefix}nope`);
  const refused = await sendProxyRequest(name);

  expect(unknown.status).toBe(404);
  expect(refused.status).toBe(502);
  expect(openProxySocket(name)).rejects.toThrow(/closed/);
});
