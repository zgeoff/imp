import { expect, onTestFinished, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { createInstanceClient, findImp, runImp, runImpWith } from '../lib/imp-cli';
import { waitForExec, writeGuestFile } from '../lib/imps';
import { runInContainer } from '../lib/instance';
import { HOST_B, readMoveHosts, readMoveOptions } from '../lib/move-hosts';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { parseSelfTags, waitForTailnetIp } from '../lib/tailnet';
import { hasTailscaleE2EKey } from '../lib/tailscale-key';
import { waitFor } from '../lib/wait-for';

// A move between two tag:imp-e2e nodes on this machine, with neither
// IMP_MOVE_TEST_CIDR nor IMP_PEER_URL: the real peer check, to the peer URL
// each impd builds from its tailnet IP (docs/architecture/storage/moves.md#the-steps).

// one stack for every release, so B's imps go before B
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('moves-tailnet'), stack, client };
}

// the definition of done needs the tailnet; any other run skips without the
// tag:imp-e2e OAuth client (op://imp-e2e/imp-e2e-tailscale-oauth)
test.skipIf(!hasTailscaleE2EKey() && !config.acceptance)(
  'it moves an imp between two tailnet nodes, past the peer check on their tailnet addresses',
  async () => {
    const ctx = await setupTest();

    invariant(
      hasTailscaleE2EKey(),
      'moves-tailnet needs the tag:imp-e2e OAuth client (op://imp-e2e/imp-e2e-tailscale-oauth)',
    );

    const plain = `${ctx.prefix}a`;

    // B joins the tailnet under its own name, kept up by the harness
    const hosts = readMoveHosts(readMoveOptions('host-b-tailnet'));

    const clientB = await createInstanceClient(hosts.b);
    const ipA = await waitForTailnetIp();
    const ipB = await waitForTailnetIp({ target: hosts.b });

    expect(ipA).toStartWith('100.');
    expect(ipB).toStartWith('100.');
    expect(ipB).not.toBe(ipA);

    const statusA = await runInContainer(['tailscale', 'status', '--json']);
    const statusB = await runInContainer(['tailscale', 'status', '--json'], hosts.b);

    // both join as the e2e tag, which the tailnet policy keeps away from
    // tag:imp's live impd
    expect(parseSelfTags(statusA.stdout)).toStrictEqual(['tag:imp-e2e']);
    expect(parseSelfTags(statusB.stdout)).toStrictEqual(['tag:imp-e2e']);

    // tag:imp-e2e nodes see each other only with the policy's tag:imp-e2e
    // to tag:imp-e2e:7070 grant
    await waitFor(
      "A among B's tailnet peers",
      async () => {
        const status = await runInContainer(['tailscale', 'status', '--json'], hosts.b);

        if (!status.stdout.includes(`"${ipA}"`)) {
          throw new Error(
            `B does not see A (${ipA}): add { "src": ["tag:imp-e2e"], "dst": ["tag:imp-e2e"], "ip": ["tcp:7070"] } to the tailnet policy`,
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
