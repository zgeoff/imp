import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { config } from '../lib/config';
import { assertState, readInfo, requireImp, runImp } from '../lib/imp-cli';
import { createImp, holdImp } from '../lib/imps';
import { REPO_ROOT, runCommand } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

const prefix = setupSuite('tailscale');
const name = `${prefix}a`;
const NOT_READY = 'tailscale needs TAILSCALE_AUTHKEY (env or .env) and this machine on the tailnet';

const PeerSchema = z.object({
  TailscaleIPs: z.array(z.string()).default([]),
  Online: z.boolean().default(false),
});

const TailscaleStatusSchema = z.object({
  BackendState: z.string(),
  Peer: z.record(z.string(), PeerSchema).default({}),
});

// The key impd joins with comes from the env or .env, which scripts/dev.sh
// hands to the container. Only its presence is checked, never its value.
function checkAuthKey(): boolean {
  if ((process.env['TAILSCALE_AUTHKEY'] ?? '') !== '') {
    return true;
  }

  const envFile = join(REPO_ROOT, '.env');

  return existsSync(envFile) && /^TAILSCALE_AUTHKEY=.+/m.test(readFileSync(envFile, 'utf8'));
}

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

async function readTailnetBody(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const body = await response.text();

  expect(response.ok).toBeTrue();

  return body.trim();
}

const localStatus = await readLocalStatus();

const ready = checkAuthKey() && localStatus?.BackendState === 'Running';

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

    await waitFor(
      'impd tailscale state Running',
      async () => {
        const info = await readInfo();

        expect(info.tailscale.state).toBe('Running');
      },
      { timeoutMs: 120_000 },
    );

    const info = await readInfo();

    const ip = info.tailscale.ip ?? '';

    expect(ip).toStartWith('100.');

    // by IP, not by name: an offline node from an earlier run can still hold
    // the name, and then this node is imp-1
    const status = await readLocalStatus();

    const peers = Object.values(status?.Peer ?? {});

    expect(peers.some((peer) => peer.Online && peer.TailscaleIPs.includes(ip))).toBeTrue();

    console.log(`    tailnet host ${String(info.tailscale.hostname)} at ${ip}`);

    await createImp(name, '--image', 'e2e-tiny', '--memory', '512');
    await holdImp(name);

    const row = await requireImp(name);
    const urls = await runImp('url', name);

    const url = urls.split('\n')[1] ?? '';
    const byIp = `http://${ip}:${String(row.port)}/`;

    expect(url).not.toBe('');

    await waitFor(`${byIp} over the tailnet`, async () => {
      const body = await readTailnetBody(byIp);

      expect(body).toBe('e2e-tiny-ok');
    });

    await waitFor(`${url} over the tailnet`, async () => {
      const body = await readTailnetBody(url);

      expect(body).toBe('e2e-tiny-ok');
    });

    await runImp('hold', name, '0');
    await runImp('sleep', name);
    await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'));

    const woken = await readTailnetBody(url);

    expect(woken).toBe('e2e-tiny-ok');
  },
);
