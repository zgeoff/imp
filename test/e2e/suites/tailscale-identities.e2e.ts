import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, runImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import {
  TAILNET_NOT_READY,
  isTailnetReady,
  readLocalTailscaleStatus,
  sendTailnetRpc,
  waitForTailnetIp,
} from '../lib/tailnet';
import { readTailscaleAuthKey } from '../lib/tailscale-key';

// Tailnet identity rules (docs/guides/tailscale.md): a member that a rule
// names reaches impd's API with no token, at the rule's scope. The suite's
// settings hold the rule (suites.ts).

// one stack for every release
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('tailscale'), stack, client };
}

const localStatus = await readLocalTailscaleStatus();
const authKey = await readTailscaleAuthKey();

const ready = isTailnetReady(localStatus?.BackendState ?? null, authKey);

if (!ready && !config.acceptance) {
  console.log(`    ${TAILNET_NOT_READY}; skipped`);
}

// the definition of done needs the tailnet; any other run skips without it
test.skipIf(!ready && !config.acceptance)(
  'it lets a tailnet member a rule names reach the API without a token, with that scope only',
  async () => {
    const ctx = await setupTest();

    if (!ready) {
      throw new Error(TAILNET_NOT_READY);
    }

    const name = `${ctx.prefix}rule`;

    await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--memory', '512');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

    await waitForExec(name);

    const ip = await waitForTailnetIp();
    const whoami = await sendTailnetRpc(ip, 'tokens/whoami', {});
    const stop = await sendTailnetRpc(ip, 'imps/stop', { name });
    const identity: unknown = await whoami.json();

    expect(identity).toMatchObject({ json: { kind: 'tailnet', scope: 'read', imps: null } });
    expect(stop.status).toBe(403);
  },
);
