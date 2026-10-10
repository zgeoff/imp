import type { DevInstance } from './instance';
import { buildMoveSettings, readMoveOptions } from './move-hosts';
import type { HostBFixtureName } from './move-hosts';

// The images a suite boots besides impd's default. `base` is images/base,
// the Docker image: slow to build, so only the suites that need it list it.
export type FixtureImage = 'base' | 'e2e-tiny' | 'e2e-bare' | 'e2e-ws' | 'e2e-git' | 'e2e-ra';

export interface Suite {
  readonly name: string;

  // every imp the suite creates is named with this prefix
  readonly prefix: string;
  readonly images: readonly FixtureImage[];

  // its journey files under test/e2e/suites, in run order, when they are more
  // than <name>.e2e.ts; each runs as its own bun test process
  readonly journeys?: readonly string[];

  // the impd settings every journey runs on, over the run's: the harness
  // reboots the instance onto them before the first journey and back after
  // the last (runSuites); null keeps the run's
  readonly settings?: (target: Readonly<DevInstance>) => Readonly<Record<string, string>> | null;

  // what runs beside the instance for every journey: the harness starts it
  // before the first, resets it after each, and stops it after the last
  // (runSuites)
  readonly fixtures?: readonly HostBFixtureName[];
}

// Every suite, in run order. The order is the acceptance numbering
// (results.json `section1` is lifecycle), and restart runs after scale so it
// re-adopts a full house.
export const SUITES: readonly Suite[] = [
  {
    name: 'lifecycle',
    prefix: 'e2e-life-',
    images: [],
    journeys: ['lifecycle', 'lifecycle-events'],
  },
  { name: 'docker', prefix: 'e2e-dock-', images: ['base'] },
  {
    name: 'images',
    prefix: 'e2e-img-',
    images: ['base'],
    journeys: ['images-build', 'images-refusals', 'images-isolation'],
  },

  // a registry on the host's loopback; skips unless its name resolves there,
  // as CI's /etc/hosts makes it
  {
    name: 'registry',
    prefix: 'e2e-reg-',
    images: [],
    journeys: ['registry-moved-tag', 'registry-copy-from', 'registry-multi-platform'],

    // the host engine's builds: a builder imp may not reach the host's
    // loopback, by design, so not this registry either
    settings: () => ({ IMP_BUILD_ISOLATION: 'host' }),
  },
  { name: 'checkpoints', prefix: 'e2e-cp-', images: ['e2e-tiny'] },
  { name: 'disks', prefix: 'e2e-disk-', images: ['e2e-tiny'] },
  {
    name: 'sleep',
    prefix: 'e2e-slp-',
    images: ['e2e-bare', 'e2e-ws'],
    journeys: ['sleep-memory', 'sleep-websocket'],
  },
  {
    name: 'scale',
    prefix: 'e2e-scale-',
    images: ['e2e-tiny'],

    // long enough that only the governor sleeps imps, or the budget never
    // fills
    settings: () => ({ IMP_IDLE_TIMEOUT_S: '600' }),
  },
  { name: 'restart', prefix: 'e2e-rs-', images: ['e2e-tiny', 'e2e-bare'] },
  {
    name: 'tailscale',
    prefix: 'e2e-ts-',
    images: ['e2e-tiny'],
    journeys: ['tailscale-reach', 'tailscale-identities', 'tailscale-names'],

    // the rule tailscale-identities proves: impd reads it at start, and the
    // reboot keeps the node
    settings: () => ({
      IMP_TAILNET_IDENTITIES: JSON.stringify([{ match: '*', scope: 'read' }]),
    }),
  },
  { name: 'mcp', prefix: 'e2e-mcp-', images: ['e2e-tiny'] },
  { name: 'mcp-oauth', prefix: 'e2e-oa-', images: ['e2e-tiny'] },
  { name: 'sessions', prefix: 'e2e-ses-', images: ['e2e-bare'] },
  { name: 'offsets', prefix: 'e2e-off-', images: ['e2e-bare'] },
  { name: 'session-logs', prefix: 'e2e-slog-', images: ['e2e-bare'] },
  { name: 'services', prefix: 'e2e-svc-', images: ['e2e-bare'] },
  { name: 'ssh', prefix: 'e2e-ssh-', images: ['e2e-tiny'] },
  { name: 'ssh-wake', prefix: 'e2e-sshw-', images: ['e2e-tiny'] },
  { name: 'ssh-agent', prefix: 'e2e-ssha-', images: ['e2e-git'] },
  { name: 'reverse', prefix: 'e2e-rev-', images: ['e2e-git'] },
  {
    name: 'proxy',
    prefix: 'e2e-px-',
    images: ['e2e-tiny'],
    journeys: ['proxy-refusals', 'proxy-forwards', 'proxy-agent-outdated', 'proxy-tunnel-limit'],
  },
  { name: 'proxy-wake', prefix: 'e2e-pxw-', images: ['e2e-tiny'] },
  { name: 'cp', prefix: 'e2e-copy-', images: ['e2e-git'] },
  {
    name: 'connectors',
    prefix: 'e2e-conn-',
    images: ['base'],
    journeys: ['connectors-github', 'connectors-custom'],
  },
  { name: 'dashboard', prefix: 'e2e-dash-', images: ['e2e-tiny'] },
  { name: 'https', prefix: 'e2e-tls-', images: ['e2e-tiny'] },
  { name: 'tokens', prefix: 'e2e-tok-', images: ['e2e-tiny'] },
  { name: 'leases', prefix: 'e2e-lease-', images: ['e2e-tiny'] },
  {
    name: 'egress',
    prefix: 'e2e-eg-',
    images: ['e2e-tiny'],
    journeys: ['egress-box', 'egress-public'],
  },
  {
    name: 'ipv6',
    prefix: 'e2e-v6-',
    images: ['e2e-tiny', 'e2e-ra'],
    journeys: ['ipv6-nat66', 'ipv6-policy', 'ipv6-routed'],
  },
  { name: 'networks', prefix: 'e2e-net-', images: ['e2e-tiny'] },
  { name: 'cpu', prefix: 'e2e-cpu-', images: ['e2e-tiny'] },
  { name: 'templates', prefix: 'e2e-tpl-', images: ['e2e-git'] },
  { name: 'boot-templates', prefix: 'e2e-bt-', images: ['e2e-ws'] },
  {
    name: 'inner',
    prefix: 'e2e-in-',
    images: ['e2e-tiny'],
    journeys: ['inner-isolation', 'inner-restart', 'inner-agent', 'inner-wipe'],
  },

  // root in the container reaches Docker only through imp-docker-proxy; it
  // stops and starts the proxy
  {
    name: 'socket',
    prefix: 'e2e-sock-',
    images: ['e2e-tiny'],
    journeys: ['socket-refusals', 'socket-builds', 'socket-proxy-stopped'],
  },

  // a second instance beside the run's, the suite's fixture: over a Docker
  // network, with the instance rebooted onto it, then over the tailnet
  {
    name: 'moves',
    prefix: 'e2e-mv-',
    images: ['e2e-tiny', 'base'],
    journeys: [
      'moves-cold',
      'moves-leases',
      'moves-abort',
      'moves-place',
      'moves-list',
      'moves-warm-open',
      'moves-warm-box',
      'moves-warm-pair',
    ],
    fixtures: ['host-b'],
    settings: (target) => buildMoveSettings(readMoveOptions('host-b'), target.portOffset),
  },
  {
    name: 'moves-tailnet',
    prefix: 'e2e-mvt-',
    images: ['e2e-tiny'],
    journeys: ['moves-tailnet-peer', 'moves-tailnet-names'],
    fixtures: ['host-b-tailnet'],
    settings: (target) => buildMoveSettings(readMoveOptions('host-b-tailnet'), target.portOffset),
  },

  // kills impd, Firecracker and the container; reboots the instance
  { name: 'chaos', prefix: 'e2e-chaos-', images: ['e2e-bare'] },

  // reboots the instance with the jailer off, then on again
  {
    name: 'jail',
    prefix: 'e2e-jail-',
    images: ['e2e-bare'],
    journeys: ['jail', 'jail-rollback', 'jail-oom', 'jail-remove'],
  },
  { name: 'memory', prefix: 'e2e-mem-', images: ['e2e-tiny'] },

  // skips unless KSM runs on this host, as CI turns it on; reboots the instance
  { name: 'ksm', prefix: 'e2e-ksm-', images: ['e2e-tiny'] },

  // last: it reboots the instance with backups on, then off again
  { name: 'backups', prefix: 'e2e-bk-', images: ['e2e-tiny'] },
];

// `acceptance` is the definition of done: every suite, tailscale required.
// `fast` is what CI runs; docs/guides/development.md#end-to-end-tests lists
// its suites.
export const SUITE_SETS: Readonly<Record<string, readonly string[]>> = {
  acceptance: SUITES.map((suite) => suite.name),
  fast: [
    'lifecycle',
    'checkpoints',
    'disks',
    'sleep',
    'restart',
    'mcp',
    'offsets',
    'session-logs',
    'services',
    'ssh',
    'ssh-agent',
    'reverse',
    'proxy',
    'dashboard',
    'tokens',
    'leases',
    'cpu',
    'templates',
    'boot-templates',
    'inner',
    'socket',
    'registry',
    'jail',
    'memory',
    'ksm',
  ],
};

// The fast set as three static lists in SUITES order, one per CI runner and
// instance; each held about 225 s of suite work in CI runs 37683236504 and
// 37680258353. Rebalance by the times in .cache/e2e/results.json.
export const FAST_GROUPS: readonly (readonly string[])[] = [
  [
    'lifecycle',
    'registry',
    'checkpoints',
    'disks',
    'restart',
    'offsets',
    'session-logs',
    'services',
    'ssh',
    'ssh-agent',
    'proxy',
    'dashboard',
    'tokens',
    'leases',
    'cpu',
    'templates',
    'boot-templates',
    'socket',
  ],
  ['sleep', 'reverse', 'jail'],
  ['mcp', 'inner', 'memory', 'ksm'],
];

// The group whose CI runner also runs the host networking tests (bun run
// test:host), so they run once: group 1 installs the dashboard's browser and
// builds the most fixture images, and group 3 has the most suite work.
export const HOST_TESTS_GROUP = 2;

// the journey files a suite runs, each as its own bun test process
export function listJourneys(suite: Readonly<Suite>): readonly string[] {
  return suite.journeys ?? [suite.name];
}

// the prefix a suite's journeys name what they make with
export function readSuitePrefix(name: string): string {
  const suite = SUITES.find((candidate) => candidate.name === name);

  if (suite === undefined) {
    throw new Error(`no suite named ${name}`);
  }

  return suite.prefix;
}

// the impd settings a suite's journeys run on for `target`, null for the
// run's own
export function readSuiteSettings(
  name: string,
  target: Readonly<DevInstance>,
): Readonly<Record<string, string>> | null {
  const suite = SUITES.find((candidate) => candidate.name === name);

  if (suite === undefined) {
    throw new Error(`no suite named ${name}`);
  }

  return suite.settings?.(target) ?? null;
}

// generous: a journey's own waits fail long before this
const JOURNEY_TIMEOUT_MS = 3_600_000;

// Plain `bun test` skips *.e2e.ts; a ./ path runs one anyway, where a bare
// path is a name filter. The suites' own bunfig has no MSW server. --bail ends
// a journey file at its first failure.
export function buildJourneyArgv(bunPath: string, journey: string): readonly string[] {
  return [
    bunPath,
    'test',
    '--config=test/e2e/bunfig.toml',
    '--bail',
    '--timeout',
    String(JOURNEY_TIMEOUT_MS),
    `./test/e2e/suites/${journey}.e2e.ts`,
  ];
}
