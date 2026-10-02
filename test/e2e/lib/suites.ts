// The images a suite boots besides impd's default. `base` is images/base,
// the Docker image: slow to build, so only the suites that need it list it.
export type FixtureImage = 'base' | 'e2e-tiny' | 'e2e-bare' | 'e2e-ws';

export interface Suite {
  readonly name: string;

  // every imp the suite creates is named with this prefix
  readonly prefix: string;
  readonly images: readonly FixtureImage[];
}

// Every suite, in run order. The order is the acceptance numbering
// (results.json `section1` is lifecycle), and restart runs after scale so it
// re-adopts a full house.
export const SUITES: readonly Suite[] = [
  { name: 'lifecycle', prefix: 'e2e-life-', images: [] },
  { name: 'docker', prefix: 'e2e-dock-', images: ['base'] },
  { name: 'images', prefix: 'e2e-img-', images: ['base'] },
  { name: 'checkpoints', prefix: 'e2e-cp-', images: ['e2e-tiny'] },
  { name: 'sleep', prefix: 'e2e-slp-', images: ['e2e-bare', 'e2e-ws'] },
  { name: 'scale', prefix: 'e2e-scale-', images: ['e2e-tiny'] },
  { name: 'restart', prefix: 'e2e-rs-', images: ['e2e-tiny', 'e2e-bare'] },
  { name: 'tailscale', prefix: 'e2e-ts-', images: ['e2e-tiny'] },
  { name: 'sessions', prefix: 'e2e-ses-', images: ['e2e-bare'] },
];

// `acceptance` is the definition of done: every suite, tailscale required.
// `fast` is what CI runs: create, exec, checkpoint and restore, sleep and
// wake by HTTP, restart.
export const SUITE_SETS: Readonly<Record<string, readonly string[]>> = {
  acceptance: SUITES.map((suite) => suite.name),
  fast: ['lifecycle', 'checkpoints', 'sleep', 'restart'],
};

// generous: a suite's own waits fail long before this
const SUITE_TIMEOUT_MS = 3_600_000;

// Plain `bun test` skips *.e2e.ts; a ./ path runs one anyway, where a bare
// path is a name filter. --bail ends a suite at its first failure: the steps
// build on each other.
export function buildSuiteArgv(bunPath: string, name: string): readonly string[] {
  return [
    bunPath,
    'test',
    '--bail',
    '--timeout',
    String(SUITE_TIMEOUT_MS),
    `./test/e2e/suites/${name}.e2e.ts`,
  ];
}
