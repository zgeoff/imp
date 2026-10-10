import { expect, onTestFinished, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, findImp, runImp, runImpWith } from '../lib/imp-cli';
import { waitForExec, writeGuestFile } from '../lib/imps';
import { runInContainer } from '../lib/instance';
import { HOST_B, readMoveHosts, readMoveOptions } from '../lib/move-hosts';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitForTailnetIp } from '../lib/tailnet';
import { readTailscaleAuthKey } from '../lib/tailscale-key';
import { waitFor } from '../lib/wait-for';

// A move between two tag:imp nodes on this machine, with neither
// IMP_MOVE_TEST_CIDR nor IMP_PEER_URL: the real peer check, to the peer URL
// each impd builds from its tailnet IP (docs/architecture/moves.md#scope).

// one stack for every release, so B's imps go before B
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('moves-tailnet'), stack, client };
}

const NOT_READY = 'moves-tailnet needs TAILSCALE_AUTHKEY (env, 1Password or .env)';

const authKey = await readTailscaleAuthKey();

if (authKey === null && !config.acceptance) {
  console.log(`    ${NOT_READY}; skipped`);
}

// the definition of done needs the tailnet; any other run skips without it
test.skipIf(authKey === null && !config.acceptance)(
  'it moves an imp between two tailnet nodes, past the peer check on their tailnet addresses',
  async () => {
    const ctx = await setupTest();

    invariant(authKey, NOT_READY);

    const plain = `${ctx.prefix}a`;

    // B joins the tailnet under its own name, kept up by the harness
    const hosts = readMoveHosts(readMoveOptions('host-b-tailnet'));

    const clientB = await createInstanceClient(hosts.b);
    const ipA = await waitForTailnetIp();
    const ipB = await waitForTailnetIp({ target: hosts.b });

    expect(ipA).toStartWith('100.');
    expect(ipB).toStartWith('100.');
    expect(ipB).not.toBe(ipA);

    // tag:imp nodes see each other only with the policy's tag:imp to
    // tag:imp:7070 rule (docs/guides/hosts.md#moves)
    await waitFor(
      "A among B's tailnet peers",
      async () => {
        const status = await runInContainer(['tailscale', 'status', '--json'], hosts.b);

        if (!status.stdout.includes(`"${ipA}"`)) {
          throw new Error(
            `B does not see A (${ipA}): add { "action": "accept", "src": ["tag:imp"], "dst": ["tag:imp:7070"] } to the tailnet policy`,
          );
        }
      },
      { timeoutMs: 30_000 },
    );

    await runImp('new', plain, '--image', resolveImageName('e2e-tiny'), '--memory', '256');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, plain));

    await waitForExec(plain);
    await writeGuestFile(plain, '/root/moved', 'tailnet-ok');
    await runImp('stop', plain);

    const out = await runImpWith({ env: hosts.cliEnv }, 'move', plain, HOST_B);

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(clientB, plain));

    const left = await findImp(plain);

    expect(out).toContain(`${plain}: moved to ${HOST_B}`);
    expect(left).toBeUndefined();

    await runImpWith({ target: hosts.b }, 'start', plain);

    const content = await waitFor(`${plain} to boot on B`, () =>
      runImpWith({ target: hosts.b }, 'exec', plain, '--', 'cat', '/root/moved'),
    );

    expect(content).toBe('tailnet-ok\n');
  },
);
