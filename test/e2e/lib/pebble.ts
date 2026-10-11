import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

// where the harness's stack keeps Pebble's minica PEM: under .cache, which
// the dev container mounts at /src/.cache
const HARNESS_MINICA_DIR = join(REPO_ROOT, '.cache', 'e2e');

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

type PebbleNames = ReturnType<typeof buildNames>;

function buildNames(prefix: string, minicaDir: string) {
  return {
    prefix,
    network: `${prefix}-acme`,
    pebble: `${prefix}-pebble`,
    challtestsrv: `${prefix}-challtestsrv`,
    minicaFile: join(minicaDir, `${prefix}-pebble-minica.pem`),
  } as const;
}

// Pebble and challtestsrv for one test, refused on a name docker already
// shows; `stack` removes only what this run made. The minica PEM goes into
// `minicaDir`, the harness's own directory when left out.
export async function startPebbleStack(
  stack: Readonly<Pick<AsyncDisposableStack, 'defer'>>,
  prefix: string,
  options: Readonly<{ minicaDir?: string }> = {},
): Promise<PebbleEndpoints> {
  const names = buildNames(prefix, options.minicaDir ?? HARNESS_MINICA_DIR);
  const started = performance.now();

  const pebbleTaken = await runCommand(['docker', 'container', 'inspect', names.pebble]);

  const challtestsrvTaken = await runCommand([
    'docker',
    'container',
    'inspect',
    names.challtestsrv,
  ]);

  const networkTaken = await runCommand(['docker', 'network', 'inspect', names.network]);

  if (pebbleTaken.exitCode === 0) {
    throw new Error(`a container named ${names.pebble} is already there`);
  }

  if (challtestsrvTaken.exitCode === 0) {
    throw new Error(`a container named ${names.challtestsrv} is already there`);
  }

  if (networkTaken.exitCode === 0) {
    throw new Error(`a network named ${names.network} is already there`);
  }

  await runChecked(['docker', 'network', 'create', names.network]);

  stack.defer(async () => {
    await runChecked(['docker', 'network', 'rm', names.network]);
  });

  await runChallTestSrv(names);

  stack.defer(async () => {
    await runChecked(['docker', 'rm', '--force', names.challtestsrv]);
  });

  await runPebble(names);

  stack.defer(async () => {
    await runChecked(['docker', 'rm', '--force', names.pebble]);
  });

  return waitForStack(names, started);
}

// The containers go, and the network unless a dev instance, which stays up
// after a run, is still on it. Nothing fails when they are not there.
async function stopHarnessStack(names: PebbleNames): Promise<void> {
  await runCommand(['docker', 'rm', '-f', names.pebble, names.challtestsrv]);
  await runCommand(['docker', 'network', 'rm', names.network]);
}

// The harness's stack, named after the instance, which the https suite
// reboots the dev instance onto. A dev instance that is still up keeps the
// network from an earlier run, so the harness takes that network again.
export async function startPebble(): Promise<void> {
  const names = buildNames(instance.container, HARNESS_MINICA_DIR);
  const started = performance.now();

  await stopHarnessStack(names);

  const network = await runCommand(['docker', 'network', 'inspect', names.network]);

  if (network.exitCode !== 0) {
    await runChecked(['docker', 'network', 'create', names.network]);
  }

  await runChallTestSrv(names);
  await runPebble(names);
  await waitForStack(names, started);
}

// true when the harness started the stack for this run
export function isPebbleRunning(): boolean {
  const names = buildNames(instance.container, HARNESS_MINICA_DIR);

  const inspect = Bun.spawnSync(['docker', 'inspect', '-f', '{{.State.Running}}', names.pebble], {
    stdout: 'pipe',
    stderr: 'ignore',
  });

  return inspect.stdout.toString().trim() === 'true';
}

// The env that scripts/dev.sh hands impd, so the dev instance joins the
// stack's network and gets its certificate from Pebble. Only the https suite
// sets it, and removes it when it ends.
const PUBLIC_IP = '203.0.113.7';

// the public listener's port inside the host container (IMP_PUBLIC_HTTPS_PORT)
export const PUBLIC_HTTPS_PORT = 7443;

export function buildPebbleEnv(
  container: string = instance.container,
): Readonly<Record<string, string>> {
  const names = buildNames(container, HARNESS_MINICA_DIR);

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
  return stopHarnessStack(buildNames(instance.container, HARNESS_MINICA_DIR));
}

function runChallTestSrv(names: PebbleNames): Promise<string> {
  return runChecked([
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
}

// no sleep before validation, and no nonce rejections: a faster test, the
// same protocol
function runPebble(names: PebbleNames): Promise<string> {
  return runChecked([
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
}

// Copies the minica PEM out and returns once Pebble and challtestsrv both
// answer. It logs how long each phase took, so a slow start names its phase.
async function waitForStack(names: PebbleNames, started: number): Promise<PebbleEndpoints> {
  const timings: string[] = [];

  const writePhaseTiming = (phase: string): void => {
    const elapsedMs = Math.round(performance.now() - started);

    timings.push(`${phase} ${String(elapsedMs)} ms`);
  };

  mkdirSync(dirname(names.minicaFile), { recursive: true });

  await runChecked([
    'docker',
    'cp',
    `${names.pebble}:/test/certs/pebble.minica.pem`,
    names.minicaFile,
  ]);

  writePhaseTiming('containers started');

  const endpoints = await readPebbleEndpoints(names);

  await waitFor(
    'Pebble to answer',
    async () => {
      // a fetch that hangs fails this attempt, so the next one runs
      const response = await fetch(endpoints.directoryUrl, {
        tls: { ca: endpoints.minicaPem },
        signal: AbortSignal.timeout(1000),
      });

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

  console.error(`pebble ${names.prefix}: ${timings.join(', ')}`);

  return endpoints;
}

async function readPebbleEndpoints(names: PebbleNames): Promise<PebbleEndpoints> {
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
  const endpoints = await readPebbleEndpoints(buildNames(instance.container, HARNESS_MINICA_DIR));
  const response = await fetch(endpoints.rootUrl, { tls: { ca: endpoints.minicaPem } });
  const pem = await response.text();

  const path = join(HARNESS_MINICA_DIR, 'pebble-root.pem');

  writeFileSync(path, pem);

  return path;
}

async function readPublishedPort(container: string, port: number): Promise<string> {
  const out = await runChecked(['docker', 'port', container, `${String(port)}/tcp`]);

  return parsePublishedPort(container, port, out);
}

// The host port in `docker port`'s output, one `<address>:<port>` line per
// binding; the first line's port when there are several
export function parsePublishedPort(container: string, port: number, out: string): string {
  const published = /:(?<port>\d+)\s*$/m.exec(out.trim())?.groups?.['port'];

  if (published === undefined) {
    throw new Error(`${container} publishes no port for ${String(port)}: ${out.trim()}`);
  }

  return published;
}
