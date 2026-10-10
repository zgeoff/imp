import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import {
  createInstanceClient,
  readImpUrls,
  readInfo,
  requireImp,
  runImp,
  runImpWith,
} from '../lib/imp-cli';
import { waitForExec } from '../lib/imps';
import { HOST_B, startMoveHosts, stopMoveHosts } from '../lib/move-hosts';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import {
  findServiceUrl,
  isTailnetReady,
  readLocalTailscaleStatus,
  readTailnetBody,
} from '../lib/tailnet';
import { readTailscaleAuthKey } from '../lib/tailscale-key';
import { waitFor } from '../lib/wait-for';

// A per-imp tailnet name across a move between two tag:imp nodes
// (docs/guides/tailscale.md#per-imp-names).

// one stack for every release, so B's imps go before B
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('moves-tailnet'), stack, client };
}

const NAMES_BLOCKED =
  'the tailnet name handover waits for the Tailscale Services OAuth client of #30 (op://cloud/imp-tailscale-oauth); set IMP_E2E_TAILNET_NAMES=1 once it exists';

const localStatus = await readLocalTailscaleStatus();
const authKey = await readTailscaleAuthKey();

const namesReady =
  isTailnetReady(localStatus?.BackendState ?? null, authKey) &&
  process.env['IMP_E2E_TAILNET_NAMES'] === '1';

if (!namesReady) {
  console.log(`    ${NAMES_BLOCKED}; skipped`);
}

test.skipIf(!namesReady)(
  'it hands a per-imp tailnet name over with its imp: the source lets it go, the target takes it',
  async () => {
    const ctx = await setupTest();

    const named = `${ctx.prefix}n`;

    // per-imp names need both impds to run them under one test prefix
    const hosts = await startMoveHosts(
      { tailnet: true, env: { IMP_TAILNET_NAMES: '1', IMP_TAILNET_NAME_PREFIX: 'e2e-' } },
      ctx.prefix,
    );

    ctx.stack.defer(() => stopMoveHosts(hosts));

    const clientB = await createInstanceClient(hosts.b);

    await runImp('new', named, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, named));

    await waitForExec(named);

    const live = await waitFor(
      `${named}'s tailnet name on A`,
      async () => {
        const urls = await readImpUrls(named);

        if (urls.service === null) {
          throw new Error(`${named} has no tailnet name on A yet`);
        }

        return urls.service;
      },
      { timeoutMs: 120_000 },
    );

    await runImp('stop', named);
    await runImpWith({ env: hosts.cliEnv }, 'move', named, HOST_B);

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(clientB, named));

    const info = await readInfo();

    expect(info.tailscale.names?.live).toBe(0);

    await runImpWith({ target: hosts.b }, 'start', named);

    const moved = await waitFor(
      `${named}'s tailnet name on B`,
      async () => {
        const stdout = await runImpWith({ target: hosts.b }, 'url', named);

        const url = findServiceUrl(stdout);

        if (url === null) {
          throw new Error(`${named} has no tailnet name on B yet`);
        }

        return url;
      },
      { timeoutMs: 180_000 },
    );

    const row = await requireImp(named, hosts.b);

    // the name answers from B, over plain HTTP: its certificate is B's to get
    const body = await waitFor(
      `${moved} over the tailnet from B`,
      () => readTailnetBody(moved.replace(/^https:/v, 'http:')),
      { timeoutMs: 180_000 },
    );

    expect(moved).toBe(live);
    expect(row.state).toBe('running');
    expect(body).toBe('e2e-tiny-ok');
  },
);
