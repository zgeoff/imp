import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInstanceClient, runImpWith } from './imp-cli';
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
import { checkPrivileges } from './privileges';
import { removeDataDir } from './remove-data-dir';
import { resetBaseline } from './reset-baseline';
import { resolveDataWipe } from './resolve-data-wipe';

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

// the two ways the harness runs B: on the Docker network, or on the tailnet
// under its own name
export type HostBFixtureName = 'host-b' | 'host-b-tailnet';

// The options each fixture runs B with. Per-imp tailnet names need an OAuth
// client, so both impds run them only once IMP_E2E_TAILNET_NAMES=1 says it
// exists, and then under one test prefix.
export function readMoveOptions(fixture: HostBFixtureName): MoveHostsOptions {
  if (fixture === 'host-b') {
    return { tailnet: false };
  }

  return process.env['IMP_E2E_TAILNET_NAMES'] === '1'
    ? { tailnet: true, env: { IMP_TAILNET_NAMES: '1', IMP_TAILNET_NAME_PREFIX: 'e2e-' } }
    : { tailnet: true };
}

// A's settings for the moves: onto the network, with the test range and its
// peer URL, unless the move goes over the tailnet, which A is on already;
// null when A runs on the run's own.
export function buildMoveSettings(
  options: Readonly<MoveHostsOptions>,
  offset: number,
): Record<string, string> | null {
  if (options.tailnet && options.env === undefined) {
    return null;
  }

  const names = buildNames();
  const network = buildMoveNetwork(offset);

  return {
    ...buildHostEnv(options, network, network.ipA),
    IMP_DEV_NETWORK: names.network,
    IMP_DEV_IP: network.ipA,
  };
}

// B's part of a moves suite, which the harness runs as the suite's fixture
export interface HostBFixture {
  // the network, B on it, and the CLI config that saves it, before A's
  // settings reboot A onto the network
  readonly start: () => Promise<void>;

  // B's imps, secrets and moves that a journey named with the prefix
  readonly reset: () => Promise<void>;

  // B down and the network gone, once A is back on the run's settings
  readonly stop: () => Promise<void>;
}

// what the fixture does to the hosts, Docker and the CLI config
export interface HostBFixtureDeps {
  // the CLI config dir that saves B, made anew on each start
  readonly cliDir: string;
  readonly removeLeftovers: () => Promise<void>;
  readonly createNetwork: (name: string, network: Readonly<MoveNetwork>) => Promise<void>;

  // B up, and its container's privileges checked against deploy/
  readonly startHost: (host: Readonly<DevInstance>) => Promise<void>;

  // saves B as HOST_B in the CLI config `env` points at
  readonly login: (
    host: Readonly<DevInstance>,
    env: Readonly<Record<string, string>>,
  ) => Promise<void>;

  // the baseline reset on B for the prefix
  readonly resetHost: (host: Readonly<DevInstance>, prefix: string) => Promise<void>;

  // B down and its data dir emptied, so its next start makes it from nothing
  readonly removeHost: (host: Readonly<DevInstance>) => Promise<void>;
  readonly log: (line: string) => void;
}

function buildHostBFixtureDeps(): HostBFixtureDeps {
  return {
    cliDir: buildNames().cliDir,
    removeLeftovers: removeMoveLeftovers,
    createNetwork: async (name, network) => {
      await runChecked([
        'docker',
        'network',
        'create',
        '--subnet',
        network.subnet,
        '--gateway',
        network.gateway,
        name,
      ]);
    },
    startHost: async (host) => {
      await runDevScript('up', host);
      await checkPrivileges(host.container);
    },
    login: async (host, env) => {
      const token = await readToken(host);

      await runImpWith({ stdin: `${token}\n`, env }, 'login', host.apiUrl, '--name', HOST_B);
    },
    resetHost: async (host, prefix) => {
      const client = await createInstanceClient(host);

      await resetBaseline({ client, prefixes: [prefix], dataDir: host.dataDir });
    },
    removeHost: async (host) => {
      // refused before anything goes, as for a dir that is no instance's
      const target = await resolveDataWipe(host.dataDir);

      await runDevScript('down', host);

      if (target !== null) {
        await removeDataDir(target);
      }
    },
    log: (line) => {
      console.error(line);
    },
  };
}

export function buildHostBFixture(
  options: Readonly<MoveHostsOptions>,
  prefix: string,
  deps: Readonly<HostBFixtureDeps> = buildHostBFixtureDeps(),
): HostBFixture {
  const names = buildNames();
  const b = buildHostB(options);
  const reset = () => deps.resetHost(b, prefix);

  // B up and saved in a fresh CLI config
  const startLoggedIn = async () => {
    await deps.startHost(b);

    rmSync(deps.cliDir, { recursive: true, force: true });
    mkdirSync(deps.cliDir, { recursive: true });

    await deps.login(b, { XDG_CONFIG_HOME: deps.cliDir });
  };

  return {
    start: async () => {
      await deps.removeLeftovers();
      await deps.createNetwork(names.network, buildMoveNetwork(readOffset()));

      await startLoggedIn();

      // What an earlier, killed run or a failed journey left on B. A reset
      // that fails makes B from nothing: a receiving imp whose source is
      // gone stays marked, and impd refuses to remove it.
      try {
        await reset();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        deps.log(`    ${b.container} could not be reset, so it starts from nothing: ${reason}`);

        await deps.removeHost(b);

        await startLoggedIn();
        await reset();
      }
    },
    reset,
    stop: async () => {
      await deps.removeLeftovers();

      rmSync(deps.cliDir, { recursive: true, force: true });
    },
  };
}

// The hosts that the harness's host-B fixture keeps up with these options,
// for a journey; it starts nothing.
export function readMoveHosts(options: Readonly<MoveHostsOptions>): MoveHosts {
  const names = buildNames();

  return {
    a: instance,
    b: buildHostB(options),
    network: names.network,
    gateway: buildMoveNetwork(readOffset()).gateway,
    cliEnv: { XDG_CONFIG_HOME: names.cliDir },
    isARebooted: !options.tailnet || options.env !== undefined,
  };
}
