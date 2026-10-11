import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { assertState, createInstanceClient, readImpUrls, readInfo, runImp } from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { instance, runDevScript } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix, readSuiteSettings } from '../lib/suites';
import {
  isTailnetReady,
  readLocalTailscaleStatus,
  readTailnetBody,
  waitForTailnetIp,
} from '../lib/tailnet';
import { hasTailscaleE2EKey } from '../lib/tailscale-key';
import { waitFor } from '../lib/wait-for';

// Per-imp tailnet names need an OAuth client with the services scope and the
// tailnet policy for tag:imp-svc (docs/guides/tailscale.md#per-imp-names).

// one stack for every release, so the reboot back to the suite's settings
// runs once the imp is gone
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('tailscale'), stack, client };
}

// Bun 1.4.2 has no in-body skip, so the skip's probe runs as the file loads
const tailscaleStatus = await readLocalTailscaleStatus();

// set IMP_E2E_TAILNET_NAMES=1 once the Services OAuth client and the tailnet
// policy exist
test.skipIf(
  !isTailnetReady(tailscaleStatus, hasTailscaleE2EKey()) ||
    process.env['IMP_E2E_TAILNET_NAMES'] !== '1',
)('it answers at its own tailnet name, which wakes it and goes with it', async () => {
  const ctx = await setupTest();

  const named = `${ctx.prefix}n`;

  // the suite's settings both ways, so the journeys after this one still
  // run on them
  const settings = readSuiteSettings('tailscale', instance);

  ctx.stack.defer(() => runDevScript('reboot', instance, { ...settings }));

  // a prefix of its own, so no device or real service shares the name
  await runDevScript('reboot', instance, {
    ...settings,
    IMP_TAILNET_NAMES: '1',
    IMP_TAILNET_NAME_PREFIX: 'e2e-',
  });

  await waitForTailnetIp();
  await runImp('new', named, '--image', resolveImageName('e2e-tiny'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, named));

  await waitForExec(named);

  const live = await waitFor(
    `${named}'s tailnet name`,
    async () => {
      const urls = await readImpUrls(named);

      if (urls.service === null) {
        throw new Error(`${named} has no tailnet name yet`);
      }

      return urls.service;
    },
    { timeoutMs: 120_000 },
  );

  const plain = live.replace(/^https:/v, 'http:');

  // the first HTTPS request waits for the name's certificate
  const byHttp = await waitFor(`${plain} over the tailnet`, () => readTailnetBody(plain), {
    timeoutMs: 120_000,
  });

  const byHttps = await waitFor(`${live} over the tailnet`, () => readTailnetBody(live), {
    timeoutMs: 120_000,
  });

  expect(live).toStartWith(`https://e2e-${named}.`);
  expect(byHttp).toBe('e2e-tiny-ok');
  expect(byHttps).toBe('e2e-tiny-ok');

  // a request to the name wakes it
  await runImp('sleep', named);
  await waitFor(`${named} to sleep`, () => assertState(named, 'sleeping'));

  const woken = await readTailnetBody(live);

  expect(woken).toBe('e2e-tiny-ok');

  // the name goes with the imp
  await runImp('rm', named);

  const names = await waitFor(`${named}'s name to go`, async () => {
    const info = await readInfo();

    if (info.tailscale.names?.live !== 0) {
      throw new Error(`live names: ${JSON.stringify(info.tailscale.names)}`);
    }

    return info.tailscale.names;
  });

  expect(names).toStrictEqual({ live: 0, failed: [] });
});
