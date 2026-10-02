import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as z from 'zod';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import type { ImpRunOptions } from '../lib/imp-cli';
import {
  findImp,
  readImpUrls,
  readInfo,
  requireImp,
  runImp,
  runImpWith,
  tryImp,
} from '../lib/imp-cli';
import { createImp, writeGuestFile } from '../lib/imps';
import { runCommand } from '../lib/instance';
import { HOST_B, startMoveHosts, stopMoveHosts } from '../lib/move-hosts';
import type { MoveHosts } from '../lib/move-hosts';
import { setupSuite } from '../lib/setup-suite';
import { readTailscaleAuthKey } from '../lib/tailscale-key';
import { waitFor } from '../lib/wait-for';

// Moves between two tag:imp nodes on this machine, with neither
// IMP_MOVE_TEST_CIDR nor IMP_PEER_URL: the real peer check, to the peer URL
// each impd builds from its tailnet IP (docs/architecture/moves.md#scope).

const prefix = setupSuite('moves-tailnet');
const TINY = resolveImageName('e2e-tiny');
const plain = `${prefix}a`;
const named = `${prefix}n`;
const NOT_READY = 'moves-tailnet needs TAILSCALE_AUTHKEY (env, 1Password or .env)';

const NAMES_BLOCKED =
  'the tailnet name handover needs the Tailscale Services OAuth client and this machine on the tailnet; set IMP_E2E_TAILNET_NAMES=1 once they exist';

const InfoSchema = z.object({
  tailscale: z.object({ state: z.string().nullable(), ip: z.string().nullable() }),
});

const authKey = await readTailscaleAuthKey();

const ready = authKey !== null;

const localStatus = await runCommand(['tailscale', 'status', '--json']).catch(() => null);

const isLocalRunning = localStatus?.stdout.includes('"BackendState": "Running"') === true;
const namesReady = ready && isLocalRunning && process.env['IMP_E2E_TAILNET_NAMES'] === '1';

if (!ready && !config.acceptance) {
  console.log(`    ${NOT_READY}; skipped`);
}

if (!namesReady) {
  console.log(`    ${NAMES_BLOCKED}; skipped`);
}

let hosts: MoveHosts | null = null;

function onB(): ImpRunOptions {
  if (hosts === null) {
    throw new Error('host B is not up');
  }

  return { target: hosts.b };
}

function runMoveToB(name: string, ...args: readonly string[]): Promise<string> {
  return runImpWith({ env: hosts?.cliEnv ?? {} }, 'move', name, HOST_B, ...args);
}

// each impd's tailnet IP, once its node is up
function waitForTailnetIp(options: ImpRunOptions): Promise<string> {
  return waitFor(
    'impd tailscale state Running',
    async () => {
      const stdout = await runImpWith(options, 'info', '--json');

      const info = InfoSchema.parse(JSON.parse(stdout));

      expect(info.tailscale.state).toBe('Running');

      return info.tailscale.ip ?? '';
    },
    { timeoutMs: 120_000 },
  );
}

beforeAll(async () => {
  if (!ready) {
    return;
  }

  // per-imp names need both impds to run them under one test prefix
  const env = namesReady ? { IMP_TAILNET_NAMES: '1', IMP_TAILNET_NAME_PREFIX: 'e2e-' } : undefined;

  hosts = await startMoveHosts({ tailnet: true, ...(env !== undefined && { env }) }, prefix);
}, 1_800_000);

afterAll(async () => {
  if (hosts === null) {
    return;
  }

  for (const name of [plain, named]) {
    await tryImp(['rm', name], onB());
  }

  await stopMoveHosts(hosts);
}, 900_000);

// the definition of done needs the tailnet; any other run skips without it
test.skipIf(!ready && !config.acceptance)(
  'a move between two tailnet nodes passes the peer check on their tailnet addresses',
  async () => {
    if (!ready) {
      throw new Error(NOT_READY);
    }

    const ipA = await waitForTailnetIp({});
    const ipB = await waitForTailnetIp(onB());

    expect(ipA).toStartWith('100.');
    expect(ipB).toStartWith('100.');
    expect(ipB).not.toBe(ipA);

    await createImp(plain, '--image', TINY, '--memory', '256');
    await writeGuestFile(plain, '/root/moved', 'tailnet-ok');
    await runImp('stop', plain);

    const out = await runMoveToB(plain);
    const left = await findImp(plain);

    expect(out).toContain(`${plain}: moved to ${HOST_B}`);
    expect(left).toBeUndefined();

    await runImpWith(onB(), 'start', plain);

    const content = await waitFor(`${plain} to boot on B`, () =>
      runImpWith(onB(), 'exec', plain, '--', 'cat', '/root/moved'),
    );

    expect(content.trim()).toBe('tailnet-ok');
  },
);

// B's `imp url` line for the per-imp name, or null
async function readServiceUrlOnB(name: string): Promise<string | null> {
  const stdout = await runImpWith(onB(), 'url', name);

  return (
    stdout.split('\n').find((line) => /^https:\/\/[\w\-]+\.[\w\-]+\.ts\.net$/v.test(line)) ?? null
  );
}

async function readTailnetBody(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const body = await response.text();

  expect(response.ok).toBeTrue();

  return body.trim();
}

test.skipIf(!namesReady)(
  'a per-imp tailnet name goes with its imp: the source lets it go, the target takes it',
  async () => {
    await createImp(named, '--image', TINY, '--memory', '256');

    const live = await waitFor(
      `${named}'s tailnet name on A`,
      async () => {
        const urls = await readImpUrls(named);

        expect(urls.service).not.toBeNull();

        return urls.service ?? '';
      },
      { timeoutMs: 120_000 },
    );

    await runImp('stop', named);
    await runMoveToB(named);

    const info = await readInfo();

    expect(info.tailscale.names?.live).toBe(0);

    await runImpWith(onB(), 'start', named);

    const moved = await waitFor(
      `${named}'s tailnet name on B`,
      async () => {
        const url = await readServiceUrlOnB(named);

        expect(url).not.toBeNull();

        return url ?? '';
      },
      { timeoutMs: 180_000 },
    );

    expect(moved).toBe(live);

    const row = await requireImp(named, onB().target);

    expect(row.state).toBe('running');

    // the name answers from B, over plain HTTP: its certificate is B's to get
    await waitFor(
      `${moved} over the tailnet from B`,
      async () => {
        const body = await readTailnetBody(moved.replace(/^https:/v, 'http:'));

        expect(body).toBe('e2e-tiny-ok');
      },
      { timeoutMs: 180_000 },
    );
  },
);
