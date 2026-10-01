import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { config } from './lib/config';
import { createMissingImages } from './lib/fixtures';
import { listImageNames, readInfo, runImp } from './lib/imp-cli';
import { removeImpsWithPrefix } from './lib/imps';
import {
  REPO_ROOT,
  instance,
  readImpdLogTail,
  readToken,
  runChecked,
  runCommand,
  runDevScript,
} from './lib/instance';
import type { HarnessArgs } from './lib/parse-args';
import { parseArgs } from './lib/parse-args';
import type { FixtureImage } from './lib/suites';
import { SUITES } from './lib/suites';

const USAGE = `imp end-to-end harness: every case drives impd through the CLI.

  scripts/test-e2e.sh [--only SUITES] [--clean | --reuse] [--keep]

  --only    comma-separated suites or sets (default: acceptance)
            suites: ${SUITES.map((suite) => suite.name).join(' ')}
            sets:   acceptance (all, tailscale required), fast (the CI subset)
  --clean   full reset first: tailnet logout, remove the dev container, wipe
            its data dir (XFS file, db, images, imps, checkpoints)
  --reuse   keep a running dev instance instead of restarting it
  --keep    leave the run's imps and images in place

Env: IMP_DEV_NAME, IMP_DEV_PORT_OFFSET, IMP_DEV_DATA pick the dev instance
(scripts/dev.sh). E2E_RAM_BUDGET_MIB (6144) and E2E_IDLE_TIMEOUT_S (10) tune
impd; E2E_SCALE_COUNT (30), E2E_SCALE_MEMORY_MIB (512), E2E_SCALE_FILL_MIB
(256), E2E_MAX_NEW_MS (3000), E2E_MAX_CHECKPOINT_MS (500) tune the suites.

Writes .cache/e2e/results.json. Exits non-zero if any suite fails.`;

// every imp and fixture image the harness creates starts with this
const PREFIX = 'e2e-';
const RESULTS_DIR = join(REPO_ROOT, '.cache', 'e2e');
const RESULTS_FILE = join(RESULTS_DIR, 'results.json');
const METRICS_FILE = join(RESULTS_DIR, 'metrics.jsonl');

// generous: a suite's own waits fail long before this
const SUITE_TIMEOUT_MS = 3_600_000;

interface Section {
  readonly index: number;
  readonly name: string;
  readonly verdict: 'PASS' | 'FAIL';
  readonly ms: number;
}

// one line of the metrics file a suite appends to: {"<key>": <value>}
const MetricSchema = z.record(z.string(), z.unknown());
let interrupted = false;

// tailnet logout, then the container and its data dir go: the run starts
// from nothing
async function resetInstance(): Promise<void> {
  const data = process.env['IMP_DEV_DATA'] ?? join(REPO_ROOT, '.data', 'dev');
  const hostImage = process.env['IMP_HOST_IMAGE'] ?? 'imp-host:dev';

  console.log(`    clean reset: tailnet logout, remove ${instance.container}, wipe ${data}`);

  const container = await runCommand(['docker', 'inspect', instance.container]);

  if (container.exitCode === 0) {
    await runCommand([
      'docker',
      'exec',
      instance.container,
      '/usr/local/lib/imp/tailscale-down.sh',
    ]);
  }

  await runDevScript('down');

  if (!existsSync(data)) {
    return;
  }

  const image = await runCommand(['docker', 'image', 'inspect', hostImage]);

  if (image.exitCode !== 0) {
    await runChecked(['docker', 'build', '-q', '-t', hostImage, join(REPO_ROOT, 'host')]);
  }

  // imp.xfs is root-owned, and a stale loop device can outlive the container
  await runChecked([
    'docker',
    'run',
    '--rm',
    '--privileged',
    '-v',
    `${data}:/d`,
    hostImage,
    'bash',
    '-c',
    'for dev in $(losetup -n -O NAME -j /d/imp.xfs 2>/dev/null); do losetup -d "$dev" || true; done; find /d -mindepth 1 -delete',
  ]);
}

function readAvailableMib(): number {
  const match = /^MemAvailable:\s+(?<kib>\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));

  return Math.floor(Number(match?.groups?.['kib'] ?? 0) / 1024);
}

// brings up the dev instance with the run's tuning, checks it, and builds
// the fixture images the selected suites need
async function setupInstance(args: HarnessArgs): Promise<void> {
  if (args.clean) {
    await resetInstance();
  } else if (!args.reuse) {
    await runDevScript('down');
  }

  await runDevScript('up');

  process.env['IMP_TOKEN'] = await readToken();

  const info = await readInfo();

  // every suite relies on this budget to stay small
  if (info.ramBudgetMib !== config.ramBudgetMib) {
    throw new Error(
      `impd RAM budget is ${String(info.ramBudgetMib)} MiB, not ${String(config.ramBudgetMib)}: ` +
        'scripts/dev.sh did not pass IMP_RAM_BUDGET_MIB, or --reuse kept an instance with its own',
    );
  }

  if (args.suites.includes('scale')) {
    const available = readAvailableMib();

    if (available < config.ramBudgetMib + 2048) {
      throw new Error(
        `only ${String(available)} MiB available; the scale suite needs the budget ` +
          `${String(config.ramBudgetMib)} MiB + 2048 MiB headroom`,
      );
    }
  }

  // leftovers of an aborted --keep run would skew RAM numbers
  await removeImpsWithPrefix(PREFIX);

  const images = new Set<FixtureImage>();

  for (const suite of SUITES) {
    if (args.suites.includes(suite.name)) {
      for (const image of suite.images) {
        images.add(image);
      }
    }
  }

  await createMissingImages([...images]);
}

async function runSuite(name: string, args: HarnessArgs): Promise<boolean> {
  const proc = Bun.spawn(
    [
      process.execPath,
      'test',
      '--bail',
      '--timeout',
      String(SUITE_TIMEOUT_MS),
      `./test/e2e/suites/${name}.e2e.ts`,
    ],
    {
      cwd: REPO_ROOT,
      stdout: 'inherit',
      stderr: 'inherit',
      env: {
        ...process.env,
        E2E_SUITES: args.suites.join(','),
        E2E_KEEP: args.keep ? '1' : '0',
        E2E_ACCEPTANCE: args.acceptance ? '1' : '0',
        E2E_METRICS_FILE: METRICS_FILE,
      },
    },
  );

  const exitCode = await proc.exited;

  if (exitCode !== 0 && !interrupted) {
    console.log(`== impd log tail\n${await readImpdLogTail(40)}`);
  }

  return exitCode === 0;
}

async function runTimed(
  index: number,
  name: string,
  body: () => Promise<boolean>,
): Promise<Section> {
  console.log(`== [${String(index)}] ${name}`);

  const started = Date.now();
  let passed: boolean;

  try {
    passed = await body();
  } catch (error) {
    console.error(`    FAIL: ${error instanceof Error ? error.message : String(error)}`);

    passed = false;
  }

  const section: Section = {
    index,
    name,
    verdict: passed ? 'PASS' : 'FAIL',
    ms: Date.now() - started,
  };

  console.log(`== ${formatSection(section)}`);

  return section;
}

function formatSection(section: Section): string {
  return `[${String(section.index)}] ${section.name.padEnd(12)} ${section.verdict} ${(section.ms / 1000).toFixed(1).padStart(7)} s`;
}

// impd's default and base images stay
async function removeLeftovers(): Promise<void> {
  console.log('== cleanup');

  await removeImpsWithPrefix(PREFIX);

  const images = await listImageNames();

  for (const image of images) {
    if (image.startsWith(PREFIX)) {
      await runImp('image', 'rm', image);
    }
  }
}

function writeResults(sections: readonly Section[]): void {
  const metrics = existsSync(METRICS_FILE)
    ? readFileSync(METRICS_FILE, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => MetricSchema.parse(JSON.parse(line)))
    : [];

  const results: Record<string, unknown> = {
    runAt: new Date().toISOString(),
    ramBudgetMib: config.ramBudgetMib,
    idleTimeoutS: config.idleTimeoutS,
  };

  for (const section of sections) {
    results[`section${String(section.index)}`] = {
      name: section.name,
      verdict: section.verdict,
      ms: section.ms,
    };
  }

  Object.assign(results, ...metrics);

  writeFileSync(RESULTS_FILE, `${JSON.stringify(results, null, 2)}\n`);

  console.log(`== results: ${RESULTS_FILE}`);
}

async function main(): Promise<number> {
  let args: HarnessArgs;

  try {
    args = parseArgs(Bun.argv.slice(2));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    console.error(`test-e2e: ${reason}\n`);
    console.error(USAGE);

    return 2;
  }

  if (args.help) {
    console.log(USAGE);

    return 0;
  }

  // scripts/dev.sh passes these to impd
  process.env['IMP_RAM_BUDGET_MIB'] = String(config.ramBudgetMib);
  process.env['IMP_IDLE_TIMEOUT_S'] = String(config.idleTimeoutS);

  // Ctrl-C reaches the running suite too; stop after it and clean up
  process.on('SIGINT', () => {
    interrupted = true;
  });

  mkdirSync(RESULTS_DIR, { recursive: true });
  rmSync(METRICS_FILE, { force: true });

  const setup = await runTimed(0, 'setup', async () => {
    await setupInstance(args);

    return true;
  });

  const sections: Section[] = [setup];

  if (setup.verdict === 'PASS') {
    for (const name of args.suites) {
      if (interrupted) {
        break;
      }

      const index = SUITES.findIndex((suite) => suite.name === name) + 1;

      const section = await runTimed(index, name, () => runSuite(name, args));

      sections.push(section);
    }

    if (!args.keep) {
      await removeLeftovers();
    }
  }

  writeResults(sections);

  console.log('== summary');

  for (const section of sections) {
    console.log(`   ${formatSection(section)}`);
  }

  const passed = sections.every((section) => section.verdict === 'PASS') && !interrupted;
  const verdict = passed ? '== PASS' : '== FAIL';

  console.log(verdict);

  if (interrupted) {
    return 130;
  }

  return passed ? 0 : 1;
}

const exitCode = await main();

process.exit(exitCode);
