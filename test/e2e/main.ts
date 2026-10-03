import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { Subprocess } from 'bun';
import * as z from 'zod';
import { config } from './lib/config';
import { createMissingImages } from './lib/fixtures';
import { listImageNames, readInfo, runImp } from './lib/imp-cli';
import { removeImpsWithPrefix } from './lib/imps';
import {
  LIB_SCRIPT,
  REPO_ROOT,
  checkHealthReady,
  getHostImage,
  instance,
  readHostImage,
  readImpdLogTail,
  readToken,
  runChecked,
  runCommand,
  runDevScript,
} from './lib/instance';
import { removeMoveLeftovers } from './lib/move-hosts';
import type { HarnessArgs } from './lib/parse-args';
import { parseArgs } from './lib/parse-args';
import { startPebble, stopPebble } from './lib/pebble';
import { checkPrivileges } from './lib/privileges';
import type { FixtureImage } from './lib/suites';
import { SUITES, buildSuiteArgv } from './lib/suites';
import { readTailscaleAuthKey } from './lib/tailscale-key';

const USAGE = `imp end-to-end harness: every case drives impd through the CLI.

  scripts/test-e2e.sh [--only SUITES] [--clean | --reuse] [--keep]

  --only    comma-separated suites or sets (default: acceptance)
            suites: ${SUITES.map((suite) => suite.name).join(' ')}
            sets:   acceptance (all, tailscale required), fast (the CI subset)
  --clean   full reset first: tailnet logout, remove the dev container, wipe
            its data dir (XFS file, db, images, imps, checkpoints), and the
            moves suites' second host and its data dir
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

interface Section {
  readonly index: number;
  readonly name: string;
  readonly verdict: 'PASS' | 'FAIL';
  readonly ms: number;
}

// one line of the metrics file a suite appends to: {"<key>": <value>}
const MetricSchema = z.record(z.string(), z.unknown());
let interrupted = false;

// the suite process running now, so a signal can stop it
let running: Subprocess | null = null;

// as scripts/dev.sh resolves it: a relative IMP_DEV_DATA is relative to the
// caller's directory
function resolveDataPath(): string {
  const configured = process.env['IMP_DEV_DATA'] ?? join(REPO_ROOT, '.data', 'dev');

  if (configured.trim() === '') {
    throw new Error('IMP_DEV_DATA is empty');
  }

  return resolve(process.cwd(), configured);
}

// The data dir to wipe, or null when it does not exist. The reset deletes it
// as root, so it must sit under <repo>/.data/ or hold an imp.xfs.
function resolveWipeTarget(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }

  const data = realpathSync(path);

  const dataRoot = existsSync(join(REPO_ROOT, '.data'))
    ? realpathSync(join(REPO_ROOT, '.data'))
    : null;

  const underDataRoot = dataRoot !== null && data.startsWith(`${dataRoot}/`);

  if (!underDataRoot && !existsSync(join(data, 'imp.xfs'))) {
    throw new Error(
      `refusing to wipe ${data}: it is not under ${join(REPO_ROOT, '.data')} and holds no imp.xfs`,
    );
  }

  return data;
}

// tailnet logout, then the container and its data dir go: the run starts
// from nothing
async function resetInstance(): Promise<void> {
  const data = resolveWipeTarget(resolveDataPath());

  // the moves suites' second host keeps its data between runs, which spares
  // its image seed; a reset takes it too, so no old migration outlives a
  // rebase that renumbered it
  const hostB = resolveWipeTarget(`${resolveDataPath()}-mv-b`);

  console.log(
    `    clean reset: tailnet logout, remove ${instance.container}, wipe ${[data, hostB].filter((dir) => dir !== null).join(' and ') || 'nothing'}`,
  );

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
  await runCommand(['docker', 'rm', '-f', `${instance.container}-mv-b`]);

  for (const dir of [data, hostB]) {
    if (dir !== null) {
      await removeDataFiles(dir);
    }
  }
}

async function removeDataFiles(data: string): Promise<void> {
  const hostImage = getHostImage();

  // scripts/lib.sh knows how the host image builds
  await runChecked(['bash', '-c', 'source "$1" && ensure_host_image', 'bash', LIB_SCRIPT]);

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

// The scale suite needs host RAM for the budget plus headroom, and disk on
// the data volume for a memory snapshot of every imp it creates.
function checkScaleHeadroom(): void {
  const availableMib = readAvailableMib();

  if (availableMib < config.ramBudgetMib + 2048) {
    throw new Error(
      `only ${String(availableMib)} MiB available; the scale suite needs the budget ` +
        `${String(config.ramBudgetMib)} MiB + 2048 MiB headroom`,
    );
  }

  const disk = statfsSync(resolveDataPath());
  const freeMib = Math.floor((disk.bavail * disk.bsize) / 1_048_576);
  const neededMib = config.scaleCount * config.scaleMemoryMib;

  if (freeMib < neededMib) {
    throw new Error(
      `only ${String(freeMib)} MiB free on the data volume; the scale suite needs ` +
        `${String(neededMib)} MiB for ${String(config.scaleCount)} snapshots`,
    );
  }
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

  // the https suite reboots the instance onto this stack, and off it again
  if (args.suites.includes('https')) {
    await startPebble();
  }

  await runDevScript('up');
  await checkPrivileges(instance.container);

  process.env['IMP_TOKEN'] = await readToken();

  const info = await readInfo();

  // every suite relies on this budget to stay small
  if (info.ramBudgetMib !== config.ramBudgetMib) {
    throw new Error(
      `impd RAM budget is ${String(info.ramBudgetMib)} MiB, not ${String(config.ramBudgetMib)}: ` +
        'scripts/dev.sh did not pass IMP_RAM_BUDGET_MIB, or --reuse kept an instance with its own',
    );
  }

  // leftovers of an aborted --keep run would skew RAM numbers
  await removeImpsWithPrefix(PREFIX);

  if (args.suites.includes('scale')) {
    checkScaleHeadroom();
  }

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

// The first signal stops the running suite (its whole process group, imp
// CLI calls included), runs no more and cleans up; a second exits at once.
function stopRun(signal: NodeJS.Signals): void {
  if (interrupted) {
    process.exit(130);
  }

  interrupted = true;

  if (running !== null) {
    process.kill(-running.pid, signal);
  }
}

async function runSuite(name: string, args: HarnessArgs): Promise<boolean> {
  const proc = Bun.spawn([...buildSuiteArgv(process.execPath, name)], {
    cwd: REPO_ROOT,
    detached: true,
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      E2E_SUITES: args.suites.join(','),
      E2E_KEEP: args.keep ? '1' : '0',
      E2E_ACCEPTANCE: args.acceptance ? '1' : '0',
      E2E_METRICS_FILE: METRICS_FILE,
    },
  });

  running = proc;

  const exitCode = await proc.exited;

  running = null;

  if (exitCode !== 0 && !interrupted) {
    const tail = await readImpdLogTail(40);

    console.log(`== impd log tail\n${tail}`);
  }

  // --bail skips the suite's afterAll; scale's imps stay for restart
  if (exitCode !== 0 && !args.keep && !(name === 'scale' && args.suites.includes('restart'))) {
    await removeSuiteImps(name);
  }

  return exitCode === 0;
}

async function removeSuiteImps(name: string): Promise<void> {
  const suite = SUITES.find((candidate) => candidate.name === name);

  try {
    await removeImpsWithPrefix(suite?.prefix ?? `${PREFIX}${name}-`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    console.error(`    could not remove the ${name} suite's imps: ${reason}`);
  }
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
async function removeLeftovers(suites: readonly string[]): Promise<void> {
  console.log('== cleanup');

  if (suites.some((suite) => suite.startsWith('moves'))) {
    await removeMoveLeftovers();
  }

  const healthy = await checkHealthReady();

  if (!healthy) {
    console.error('    impd is not ready; imps and images left in place');

    return;
  }

  try {
    await removeImpsWithPrefix(PREFIX);

    const images = await listImageNames();

    for (const image of images) {
      if (image.startsWith(PREFIX)) {
        await runImp('image', 'rm', image);
      }
    }
  } catch (error) {
    // the results and summary still matter more than a tidy instance
    const reason = error instanceof Error ? error.message : String(error);

    console.error(`    cleanup failed: ${reason}`);
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

  // one tag for the whole run: dev.sh, the suites and the clean reset
  process.env['IMP_HOST_IMAGE'] = await readHostImage();

  // scripts/dev.sh passes these to impd
  process.env['IMP_RAM_BUDGET_MIB'] = String(config.ramBudgetMib);
  process.env['IMP_IDLE_TIMEOUT_S'] = String(config.idleTimeoutS);

  // one 1Password read per run, and only when a suite needs the tailnet:
  // dev.sh and the tailscale suite take the key from the env
  if (args.suites.includes('tailscale') || args.suites.includes('moves-tailnet')) {
    process.env['IMP_TAILSCALE_OP'] = '1';
  }

  const authKey = await readTailscaleAuthKey();

  if (authKey !== null) {
    process.env['TAILSCALE_AUTHKEY'] = authKey;
  }

  // stop the running suite, run no more, and clean up
  process.on('SIGINT', () => {
    stopRun('SIGINT');
  });

  process.on('SIGTERM', () => {
    stopRun('SIGTERM');
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
      await removeLeftovers(args.suites);
    }
  }

  if (args.suites.includes('https')) {
    await stopPebble();
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
