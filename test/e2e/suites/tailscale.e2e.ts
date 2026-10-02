import { expect, test } from 'bun:test';
import * as z from 'zod';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { assertState, readImpUrls, readInfo, requireImp, runImp } from '../lib/imp-cli';
import { createImp, holdImp } from '../lib/imps';
import { runCommand, runDevScript, runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { readTailscaleAuthKey } from '../lib/tailscale-key';
import { waitFor } from '../lib/wait-for';

const prefix = setupSuite('tailscale');
const TINY = resolveImageName('e2e-tiny');
const name = `${prefix}a`;

const NOT_READY =
  'tailscale needs TAILSCALE_AUTHKEY (env, 1Password or .env) and this machine on the tailnet';

const PeerSchema = z.object({
  DNSName: z.string().default(''),
  TailscaleIPs: z.array(z.string()).default([]),
  Online: z.boolean().default(false),
});

const TailscaleStatusSchema = z.object({
  BackendState: z.string(),
  Peer: z.record(z.string(), PeerSchema).default({}),
});

async function readLocalStatus(): Promise<z.infer<typeof TailscaleStatusSchema> | null> {
  try {
    const result = await runCommand(['tailscale', 'status', '--json']);

    const status = TailscaleStatusSchema.safeParse(JSON.parse(result.stdout));

    return status.success ? status.data : null;
  } catch {
    // no tailscale CLI on this machine, or no JSON from it
    return null;
  }
}

// impd until its node is up again, as after a reboot
async function waitForTailnetIp(): Promise<string> {
  await waitFor(
    'impd tailscale state Running',
    async () => {
      const info = await readInfo();

      expect(info.tailscale.state).toBe('Running');
    },
    { timeoutMs: 120_000 },
  );

  const info = await readInfo();

  return info.tailscale.ip ?? '';
}

// a call to impd's API over the tailnet, with no token
function sendTailnetRpc(ip: string, path: string, input: unknown): Promise<Response> {
  return fetch(`http://${ip}:7070/rpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: input }),
    signal: AbortSignal.timeout(30_000),
  });
}

async function readTailnetBody(url: string, host?: string): Promise<string> {
  const response = await fetch(url, {
    ...(host !== undefined && { headers: { host } }),
    signal: AbortSignal.timeout(30_000),
  });

  const body = await response.text();

  expect(response.ok).toBeTrue();

  return body.trim();
}

const localStatus = await readLocalStatus();
const authKey = await readTailscaleAuthKey();

const ready = authKey !== null && localStatus?.BackendState === 'Running';

if (!ready && !config.acceptance) {
  console.log(`    ${NOT_READY}; skipped`);
}

// the definition of done needs the tailnet; any other run skips without it
test.skipIf(!ready && !config.acceptance)(
  'an imp answers tailnet members by IP and by name, and a tailnet request wakes it',
  async () => {
    if (!ready) {
      throw new Error(NOT_READY);
    }

    const ip = await waitForTailnetIp();
    const info = await readInfo();

    expect(ip).toStartWith('100.');

    // by IP, not by name: an offline node from an earlier run can still hold
    // the name, and then this node is imp-1
    const status = await readLocalStatus();

    const peers = Object.values(status?.Peer ?? {});
    const node = peers.find((peer) => peer.Online && peer.TailscaleIPs.includes(ip));

    expect(node).toBeDefined();

    // the host container runs its own tailscaled and still needs public DNS
    const dns = await runInContainer(['getent', 'hosts', 'pkgs.tailscale.com']);

    expect(dns.exitCode).toBe(0);

    console.log(`    tailnet host ${String(info.tailscale.hostname)} at ${ip}`);

    await createImp(name, '--image', TINY, '--memory', '512');
    await holdImp(name);

    const row = await requireImp(name);
    const urls = await readImpUrls(name);

    const url = urls.tailnet ?? '';

    expect(url).not.toBe('');

    await waitFor(`${url} over the tailnet`, async () => {
      const body = await readTailnetBody(url);

      expect(body).toBe('e2e-tiny-ok');
    });

    // every name a member can use for the node: IP, MagicDNS FQDN, short name;
    // on the imp's own port and on the proxy port with the imp's Host header
    const fqdn = (node?.DNSName ?? '').replace(/\.$/, '');
    const short = fqdn.split('.')[0] ?? '';

    expect(fqdn).not.toBe('');

    for (const host of [ip, fqdn, short]) {
      const byPort = `http://${host}:${String(row.port)}/`;
      const byProxy = `http://${host}:7080/`;

      await waitFor(`${byPort} over the tailnet`, async () => {
        const body = await readTailnetBody(byPort);

        expect(body).toBe('e2e-tiny-ok');
      });

      await waitFor(`${byProxy} over the tailnet`, async () => {
        const body = await readTailnetBody(byProxy, `${name}.imp.localhost`);

        expect(body).toBe('e2e-tiny-ok');
      });
    }

    await runImp('hold', name, '0');
    await runImp('sleep', name);
    await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'));

    const woken = await readTailnetBody(url);

    expect(woken).toBe('e2e-tiny-ok');
  },
);

test.skipIf(!ready && !config.acceptance)(
  'a tailnet member a rule names reaches the API without a token, with that scope only',
  async () => {
    if (!ready) {
      throw new Error(NOT_READY);
    }

    // impd reads the rules at start; the reboot keeps its node and imps
    process.env['IMP_TAILNET_IDENTITIES'] = JSON.stringify([{ match: '*', scope: 'read' }]);

    try {
      await runDevScript('reboot');

      const ip = await waitForTailnetIp();
      const whoami = await sendTailnetRpc(ip, 'tokens/whoami', {});
      const stop = await sendTailnetRpc(ip, 'imps/stop', { name });
      const identity: unknown = await whoami.json();

      expect(identity).toMatchObject({ json: { kind: 'tailnet', scope: 'read', imps: null } });
      expect(stop.status).toBe(403);
    } finally {
      delete process.env['IMP_TAILNET_IDENTITIES'];

      await runDevScript('reboot');
    }
  },
);
