import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as z from 'zod';
import { findBootFallbacks } from './lib/boot-fallbacks';
import { config } from './lib/config';
import { createMissingImages } from './lib/fixtures';
import { createInstanceClient, listImageNames, readInfo, runImp } from './lib/imp-cli';
import { removeImpsWithPrefix } from './lib/imps';
import {
  LIB_SCRIPT,
  REPO_ROOT,
  checkHealthReady,
  getHostImage,
  instance,
  readHostImage,
  readImpdLogSince,
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
import { resetBaseline } from './lib/reset-baseline';
import { runSuite, stopSuiteGroup } from './lib/run-suite';
import { checkRunPassed, runSuites } from './lib/run-suites';
import type { FixtureImage } from './lib/suites';
import { FAST_GROUPS, SUITES, buildJourneyArgv, listJourneys } from './lib/suites';
import { readTailscaleAuthKey } from './lib/tailscale-key';
import { resolveWipeTarget } from './lib/wipe-target';
import type { WipeTarget } from './lib/wipe-target';
import { ZFS_OWNER_FILE, resetZfsRoot } from './lib/zfs-owner';
import type { ZfsCommandResult } from './lib/zfs-owner';

const USAGE = `imp end-to-end harness: every case drives impd through the CLI.

  scripts/test-e2e.sh [--only SUITES | --group N] [--clean | --reuse] [--keep]

  --only    comma-separated suites or sets (default: acceptance)
            suites: ${SUITES.map((suite) => suite.name).join(' ')}
            sets:   acceptance (all, tailscale required), fast (the CI subset)
  --group   one of the fast set's ${String(FAST_GROUPS.length)} CI groups, 1 to ${String(FAST_GROUPS.length)}
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

// the pid of the suite process running now, which leads its group, so a
// signal can stop it
let running: number | null = null;

// as scripts/dev.sh resolves it: a relative IMP_DEV_DATA is relative to the
// caller's directory
function resolveDataPath(): string {
  const configured = process.env['IMP_DEV_DATA'] ?? join(REPO_ROOT, '.data', 'dev');

  if (configured.trim() === '') {
    throw new Error('IMP_DEV_DATA is empty');
  }

  return resolve(process.cwd(), configured);
}

// zpool and zfs as root, from the host image, as the data wipe runs
async function runHostZfs(argv: readonly string[]): Promise<ZfsCommandResult> {
  // scripts/lib.sh knows how the host image builds
  await runChecked(['bash', '-c', 'source "$1" && ensure_host_image', 'bash', LIB_SCRIPT]);

  return runCommand(['docker', 'run', '--rm', '--privileged', getHostImage(), ...argv]);
}

// the wipe's target for a data dir, as this run's instance stores it
function resolveDataWipe(path: string): Promise<WipeTarget | null> {
  return resolveWipeTarget({
    path,
    repoRoot: REPO_ROOT,
    storageBackend: process.env['IMP_STORAGE_BACKEND'],
    zfsRoot: process.env['IMP_ZFS_ROOT'],
    run: runHostZfs,
  });
}

// tailnet logout, then the container and its data dir go: the run starts
// from nothing
async function resetInstance(): Promise<void> {
  const data = await resolveDataWipe(resolveDataPath());

  // the moves suites' second host keeps its data between runs, which spares
  // its image seed; a reset takes it too, so no old migration outlives a
  // rebase that renumbered it
  const hostB = await resolveDataWipe(`${resolveDataPath()}-mv-b`);

  const targets = [data, hostB].filter((target) => target !== null);

  console.log(
    `    clean reset: tailnet logout, remove ${instance.container}, wipe ${targets.map((target) => target.dir).join(' and ') || 'nothing'}`,
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

  for (const target of targets) {
    await removeDataFiles(target.dir);

    if (target.zfs !== null) {
      await resetZfsRoot(target.zfs, runHostZfs);
    }
  }
}

// every file in the data dir but the ZFS owner file, which the next reset
// still needs to prove the dir
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
    `for dev in $(losetup -n -O NAME -j /d/imp.xfs 2>/dev/null); do losetup -d "$dev" || true; done; find /d -mindepth 1 ! -path /d/${ZFS_OWNER_FILE} -delete`,
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

  await startInstance(args);
}

// up with the run's tuning, checked, at the baseline, with the images the
// run's suites need
async function startInstance(args: HarnessArgs): Promise<void> {
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

  // leftovers of an aborted or --keep run would skew RAM numbers
  await resetSuites(SUITES.map((suite) => suite.prefix));

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
    stopSuiteGroup(running, signal);
  }
}

// Every imp, network, secret, token, OAuth client and image the suites named
// with these prefixes goes; the fixture images stay.
async function resetSuites(prefixes: readonly string[]): Promise<void> {
  await resetBaseline({
    client: await createInstanceClient(),
    prefixes,
    dataDir: resolveDataPath(),
  });
}

async function runJourneyProcess(journey: string, args: HarnessArgs): Promise<number> {
  const exitCode = await runSuite({
    argv: buildJourneyArgv(process.execPath, journey),
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      E2E_KEEP: args.keep ? '1' : '0',
      E2E_ACCEPTANCE: args.acceptance ? '1' : '0',
      E2E_METRICS_FILE: METRICS_FILE,
    },
    onStart: (pid) => {
      running = pid;
    },
  });

  // gone: a signal during the reset has no group to stop
  running = null;

  if (exitCode !== 0 && !interrupted) {
    const tail = await readImpdLogTail(40);

    console.log(`== impd log tail\n${tail}`);
  }

  return exitCode;
}

// a suite's number in the acceptance order, as results.json names it
function findSuiteIndex(name: string): number {
  return SUITES.findIndex((suite) => suite.name === name) + 1;
}

// chaos kills firecracker on purpose, so a restore there may fall back
const FALLBACK_SUITES: ReadonlySet<string> = new Set(['chaos']);

// A template restore that fell back still creates the imp, so the suite
// passes; the fallback is a failure all the same, unless the suite causes it
async function checkNoBootFallbacks(name: string, since: Readonly<Date>): Promise<boolean> {
  let log: string;

  try {
    log = await readImpdLogSince(since);
  } catch (error) {
    console.log(`== ${name}: no impd log to check for boot fallbacks: ${String(error)}`);

    return false;
  }

  const fallbacks = findBootFallbacks(log);

  if (fallbacks.length === 0) {
    return true;
  }

  const isAllowed = FALLBACK_SUITES.has(name);
  const verdict = isAllowed ? 'fell back, as the suite may cause' : 'fell back to the kernel';

  console.log(`== ${name}: a boot template ${verdict}\n${fallbacks.join('\n')}`);

  return isAllowed;
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
  let stoppedBecause: string | null = null;

  if (setup.verdict === 'PASS') {
    const startedAt = new Map<string, Date>();

    const run = await runSuites({
      names: args.suites,
      prefixOf: (name) =>
        SUITES.find((suite) => suite.name === name)?.prefix ?? `${PREFIX}${name}-`,
      journeysOf: (name) => {
        const suite = SUITES.find((candidate) => candidate.name === name);

        return suite === undefined ? [name] : listJourneys(suite);
      },
      keep: args.keep,
      runJourney: (journey) => {
        startedAt.set(journey, new Date());

        return runJourneyProcess(journey, args);
      },
      checkJourney: (suite, journey) =>
        checkNoBootFallbacks(suite, startedAt.get(journey) ?? new Date()),
      reset: resetSuites,
      reboot: () => runDevScript('reboot'),

      // a fresh instance: the container and data dir go, and come back
      // with the run's settings, baseline and images
      recreate: async () => {
        await resetInstance();
        await startInstance(args);
      },
      isInterrupted: () => interrupted,
      now: Date.now,
      onSuiteStart: (name) => {
        console.log(`== [${String(findSuiteIndex(name))}] ${name}`);
      },
      onSuiteEnd: (result) => {
        const section: Section = {
          index: findSuiteIndex(result.name),
          name: result.name,
          verdict: result.passed ? 'PASS' : 'FAIL',
          ms: result.ms,
        };

        sections.push(section);
        console.log(`== ${formatSection(section)}`);
      },
      log: (line) => {
        console.error(line);
      },
    });

    stoppedBecause = run.stoppedBecause;

    if (stoppedBecause !== null && stoppedBecause !== 'interrupted') {
      console.error(`== the run stopped: ${stoppedBecause}`);
    }

    // an instance that could not be made anew has nothing left to tidy
    const isUp = stoppedBecause === null || stoppedBecause === 'interrupted';

    if (!args.keep && isUp) {
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

  const passed = checkRunPassed({
    passed: sections.map((section) => section.verdict === 'PASS'),
    stoppedBecause,
    interrupted,
  });

  const verdict = passed ? '== PASS' : '== FAIL';

  console.log(verdict);

  if (interrupted) {
    return 130;
  }

  return passed ? 0 : 1;
}

const exitCode = await main();

process.exit(exitCode);
