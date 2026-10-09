import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, instance, runChecked, runCommand } from './instance';
import { waitFor } from './wait-for';

// Let's Encrypt's test CA and the DNS server it asks, pinned by digest
const PEBBLE_IMAGE =
  'ghcr.io/letsencrypt/pebble:2.10.1@sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199';

const CHALLTESTSRV_IMAGE =
  'ghcr.io/letsencrypt/pebble-challtestsrv:2.10.1@sha256:12ce21884def456bcf9786542113949e1f19dc7738d2c70e156c2d0c38a1405b';

// what scripts/pull-pebble-images.ts pulls before `bun run test:pebble`
export const PEBBLE_IMAGES = [PEBBLE_IMAGE, CHALLTESTSRV_IMAGE] as const;

// the domain impd gets in the https suite; challtestsrv answers for it
export const PEBBLE_DOMAIN = 'imp.test';

export interface PebbleEndpoints {
  // from this machine
  readonly directoryUrl: string;
  readonly rootUrl: string;
  readonly challtestsrvUrl: string;

  // Pebble's own TLS certificate chains to this CA, and is for `pebble` and
  // `localhost`: in the network the container is `pebble`, from here `localhost`
  readonly minicaFile: string;
  readonly minicaPem: string;
}

function buildNames(prefix: string) {
  return {
    network: `${prefix}-acme`,
    pebble: `${prefix}-pebble`,
    challtestsrv: `${prefix}-challtestsrv`,
    minicaFile: join(REPO_ROOT, '.cache', 'e2e', `${prefix}-pebble-minica.pem`),
  } as const;
}

// Starts Pebble and challtestsrv on a network of their own, named after the
// prefix, with their ports published on loopback, and returns once both
// answer. It logs how long each phase took, so a slow start names its phase.
export async function startPebbleStack(prefix: string): Promise<PebbleEndpoints> {
  const names = buildNames(prefix);
  const started = performance.now();
  const timings: string[] = [];

  const writePhaseTiming = (phase: string): void => {
    const elapsedMs = Math.round(performance.now() - started);

    timings.push(`${phase} ${String(elapsedMs)} ms`);
  };

  await stopPebbleStack(prefix);

  // a dev instance that is still up keeps the network from an earlier run
  const network = await runCommand(['docker', 'network', 'inspect', names.network]);

  if (network.exitCode !== 0) {
    await runChecked(['docker', 'network', 'create', names.network]);
  }

  await runChecked([
    'docker',
    'run',
    '-d',
    '--rm',
    '--name',
    names.challtestsrv,
    '--network',
    names.network,
    '--network-alias',
    'challtestsrv',
    '-p',
    '127.0.0.1::8055',
    CHALLTESTSRV_IMAGE,
    '-defaultIPv6',
    '',
    '-defaultIPv4',
    '127.0.0.1',
  ]);

  // no sleep before validation, and no nonce rejections: a faster test, the
  // same protocol
  await runChecked([
    'docker',
    'run',
    '-d',
    '--rm',
    '--name',
    names.pebble,
    '--network',
    names.network,
    '--network-alias',
    'pebble',
    '-e',
    'PEBBLE_VA_NOSLEEP=1',
    '-e',
    'PEBBLE_WFE_NONCEREJECT=0',
    '-p',
    '127.0.0.1::14000',
    '-p',
    '127.0.0.1::15000',
    PEBBLE_IMAGE,
    '-dnsserver',
    'challtestsrv:8053',
  ]);

  mkdirSync(join(REPO_ROOT, '.cache', 'e2e'), { recursive: true });

  await runChecked([
    'docker',
    'cp',
    `${names.pebble}:/test/certs/pebble.minica.pem`,
    names.minicaFile,
  ]);

  writePhaseTiming('containers started');

  const endpoints = await readPebbleEndpoints(prefix);

  await waitFor(
    'Pebble to answer',
    async () => {
      const response = await fetch(endpoints.directoryUrl, { tls: { ca: endpoints.minicaPem } });

      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)}`);
      }
    },
    { intervalMs: 50 },
  );

  writePhaseTiming('Pebble ready');

  // an issuance sets its TXT record through this API first: a call that
  // reaches the published port before challtestsrv listens stalls or fails
  await waitFor(
    'challtestsrv to answer',
    async () => {
      const response = await fetch(new URL('/clear-txt', endpoints.challtestsrvUrl), {
        method: 'POST',
        body: JSON.stringify({ host: 'startup-probe.invalid.' }),
        signal: AbortSignal.timeout(1000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)}`);
      }
    },
    { intervalMs: 50 },
  );

  writePhaseTiming('challtestsrv ready');

  console.error(`pebble ${prefix}: ${timings.join(', ')}`);

  return endpoints;
}

// The containers go, and the network unless a dev instance, which stays up
// after a run, is still on it. Nothing fails when they are not there.
export async function stopPebbleStack(prefix: string): Promise<void> {
  const names = buildNames(prefix);

  await runCommand(['docker', 'rm', '-f', names.pebble, names.challtestsrv]);
  await runCommand(['docker', 'network', 'rm', names.network]);
}

// The harness's stack, which the https suite reboots the dev instance onto
export async function startPebble(): Promise<void> {
  await startPebbleStack(instance.container);
}

// true when the harness started the stack for this run
export function isPebbleRunning(): boolean {
  const inspect = Bun.spawnSync(
    ['docker', 'inspect', '-f', '{{.State.Running}}', buildNames(instance.container).pebble],
    { stdout: 'pipe', stderr: 'ignore' },
  );

  return inspect.stdout.toString().trim() === 'true';
}

// The env that scripts/dev.sh hands impd, so the dev instance joins the
// stack's network and gets its certificate from Pebble. Only the https suite
// sets it, and removes it when it ends.
const PUBLIC_IP = '203.0.113.7';

// the public listener's port inside the host container (IMP_PUBLIC_HTTPS_PORT)
export const PUBLIC_HTTPS_PORT = 7443;

export function buildPebbleEnv(): Readonly<Record<string, string>> {
  const names = buildNames(instance.container);

  return {
    IMP_DEV_NETWORK: names.network,
    IMP_E2E: '1',
    IMP_DOMAIN: PEBBLE_DOMAIN,
    IMP_DNS_PROVIDER: 'challtestsrv',
    IMP_DNS_API_URL: 'http://challtestsrv:8055',
    IMP_ACME_DIRECTORY: 'https://pebble:14000/dir',
    IMP_ACME_CA_FILE: names.minicaFile,

    // public imps on TEST-NET-3: only the record points there, and the
    // suite reaches the public listener on loopback in the container
    IMP_PUBLIC_IP: PUBLIC_IP,
  };
}

export function stopPebble(): Promise<void> {
  return stopPebbleStack(instance.container);
}

async function readPebbleEndpoints(prefix: string): Promise<PebbleEndpoints> {
  const names = buildNames(prefix);

  const directory = await readPublishedPort(names.pebble, 14_000);
  const management = await readPublishedPort(names.pebble, 15_000);
  const challtestsrv = await readPublishedPort(names.challtestsrv, 8055);
  const minicaPem = await Bun.file(names.minicaFile).text();

  return {
    directoryUrl: `https://localhost:${directory}/dir`,
    rootUrl: `https://localhost:${management}/roots/0`,
    challtestsrvUrl: `http://127.0.0.1:${challtestsrv}`,
    minicaFile: names.minicaFile,
    minicaPem,
  };
}

// The root Pebble signs with, which it makes anew on each start: what a
// client must trust for impd's certificate. Written under .cache, which the
// dev container mounts at /src/.cache.
export async function writePebbleRoot(): Promise<string> {
  const endpoints = await readPebbleEndpoints(instance.container);
  const response = await fetch(endpoints.rootUrl, { tls: { ca: endpoints.minicaPem } });
  const pem = await response.text();

  const path = join(REPO_ROOT, '.cache', 'e2e', 'pebble-root.pem');

  writeFileSync(path, pem);

  return path;
}

async function readPublishedPort(container: string, port: number): Promise<string> {
  const out = await runChecked(['docker', 'port', container, `${String(port)}/tcp`]);

  const published = /:(?<port>\d+)\s*$/m.exec(out.trim())?.groups?.['port'];

  if (published === undefined) {
    throw new Error(`${container} publishes no port for ${String(port)}: ${out.trim()}`);
  }

  return published;
}
