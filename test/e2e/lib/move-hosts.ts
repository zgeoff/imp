import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { listImps, runImpWith, tryImp } from './imp-cli';
import type { DevInstance } from './instance';
import {
  REPO_ROOT,
  createInstance,
  instance,
  readToken,
  runChecked,
  runCommand,
  runDevScript,
} from './instance';

// The moves suites' hosts: the run's own instance as A, and B beside it on
// a Docker network, reached at its address there. B's data dir stays
// between runs, so only its first start seeds the default image.

// what the move suites run in: each instance holds about one test guest
const RAM_BUDGET_MIB = '2048';
const DEFAULT_MEMORY_MIB = '512';

// the saved host the CLI moves imps to
export const HOST_B = 'b';

export interface MoveHosts {
  readonly a: DevInstance;
  readonly b: DevInstance;
  readonly network: string;

  // the network's gateway: this machine, as both containers see it
  readonly gateway: string;

  // the CLI's env: XDG_CONFIG_HOME holds the saved host b
  readonly cliEnv: Readonly<Record<string, string>>;

  // A rebooted onto the network, and reboots back at the end
  readonly isARebooted: boolean;
}

export interface MoveNetwork {
  readonly subnet: string;
  readonly gateway: string;
  readonly ipA: string;
  readonly ipB: string;
}

// A /24 in 10.100.0.0 to 10.255.255.0, one per port offset: inside 10/8,
// clear of IMP_SUBNET's 10.66/16 and of Docker's 172.x pools, so runs in
// other worktrees and e2e slots never share it.
export function buildMoveNetwork(offset: number): MoveNetwork {
  const second = 100 + Math.floor(offset / 256);

  if (!Number.isInteger(offset) || offset < 0 || second > 255) {
    throw new Error(`no move network for port offset ${String(offset)}`);
  }

  const base = `10.${String(second)}.${String(offset % 256)}`;

  return {
    subnet: `${base}.0/24`,
    gateway: `${base}.1`,
    ipA: `${base}.10`,
    ipB: `${base}.11`,
  };
}

export interface MoveHostsOptions {
  // move over the tailnet: B joins it under its own name, and neither host
  // takes the test range or a peer URL
  readonly tailnet: boolean;

  // more env for both impds, such as per-imp tailnet names
  readonly env?: Readonly<Record<string, string>>;
}

function readOffset(): number {
  return Number(process.env['IMP_DEV_PORT_OFFSET'] ?? '0');
}

function buildNames() {
  return {
    network: `${instance.container}-mv`,
    container: `${instance.container}-mv-b`,
    cliDir: join(REPO_ROOT, '.cache', 'e2e', `${instance.container}-mv-cli`),
  };
}

// impd's env on each host
function buildHostEnv(
  options: MoveHostsOptions,
  network: MoveNetwork,
  ip: string,
): Record<string, string> {
  const shared = {
    ...options.env,
    IMP_RAM_BUDGET_MIB: RAM_BUDGET_MIB,
    IMP_DEFAULT_MEMORY_MIB: DEFAULT_MEMORY_MIB,
  };

  if (options.tailnet) {
    return shared;
  }

  return {
    ...shared,
    IMP_E2E: '1',
    IMP_MOVE_TEST_CIDR: network.subnet,
    IMP_PEER_URL: `http://${ip}:7070`,
  };
}

// B as the options make it, for starting it and for its teardown
function buildHostB(options: MoveHostsOptions): DevInstance {
  const names = buildNames();
  const network = buildMoveNetwork(readOffset());

  return createInstance({
    container: names.container,
    dataDir: `${instance.dataDir}-mv-b`,
    network: names.network,
    ip: network.ipB,
    env: {
      ...buildHostEnv(options, network, network.ipB),

      // off the tailnet, unless the suite moves over it under B's own name
      ...(options.tailnet ? { IMP_TAILSCALE_HOSTNAME: names.container } : { IMP_DEV_TAILNET: '0' }),
    },
  });
}

async function checkAOnNetwork(network: string): Promise<boolean> {
  const result = await runCommand([
    'docker',
    'inspect',
    '-f',
    `{{if index .NetworkSettings.Networks "${network}"}}yes{{end}}`,
    instance.container,
  ]);

  return result.stdout.trim() === 'yes';
}

// A failed run (--bail skips afterAll) can leave B up and A on the
// network, its only one; this puts both back, and loses nothing when the
// run is clean.
export async function removeMoveLeftovers(): Promise<void> {
  const names = buildNames();

  await runDevScript('down', buildHostB({ tailnet: false }));

  const isOnNetwork = await checkAOnNetwork(names.network);

  if (isOnNetwork) {
    await runDevScript('reboot');
  }

  await runCommand(['docker', 'network', 'rm', names.network]);
}

// Starts B, and reboots A onto the network unless the move goes over the
// tailnet, which A is on already. Removes B's imps with the prefix that an
// earlier run left.
export async function startMoveHosts(
  options: MoveHostsOptions,
  prefix: string,
): Promise<MoveHosts> {
  const names = buildNames();
  const network = buildMoveNetwork(readOffset());

  await removeMoveLeftovers();

  await runChecked([
    'docker',
    'network',
    'create',
    '--subnet',
    network.subnet,
    '--gateway',
    network.gateway,
    names.network,
  ]);

  const rebootEnv = {
    ...buildHostEnv(options, network, network.ipA),
    IMP_DEV_NETWORK: names.network,
    IMP_DEV_IP: network.ipA,
  };

  const isARebooted = !options.tailnet || options.env !== undefined;

  if (isARebooted) {
    await runDevScript('reboot', instance, rebootEnv);
  }

  const b = buildHostB(options);

  await runDevScript('up', b);

  rmSync(names.cliDir, { recursive: true, force: true });
  mkdirSync(names.cliDir, { recursive: true });

  const cliEnv = { XDG_CONFIG_HOME: names.cliDir };

  const token = await readToken(b);

  await runImpWith({ stdin: `${token}\n`, env: cliEnv }, 'login', b.apiUrl, '--name', HOST_B);

  const rows = await listImps(b);

  for (const row of rows.filter((candidate) => candidate.name.startsWith(prefix))) {
    await tryImp(['rm', row.name], { target: b });
  }

  return {
    a: instance,
    b,
    network: names.network,
    gateway: network.gateway,
    cliEnv,
    isARebooted,
  };
}

// B down, A back to the run's own settings, the network gone
export async function stopMoveHosts(hosts: MoveHosts): Promise<void> {
  await runDevScript('down', hosts.b);

  if (hosts.isARebooted) {
    await runDevScript('reboot');
  }

  await removeMoveLeftovers();

  rmSync(buildNames().cliDir, { recursive: true, force: true });
}
