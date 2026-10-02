import { expect, test } from 'bun:test';
import { config } from '../lib/config';
import { getThroughProxy } from '../lib/http';
import {
  findImp,
  listImps,
  readInfo,
  readState,
  requireImp,
  runImp,
  runShellInImp,
  tryImp,
} from '../lib/imp-cli';
import { registerImp, removeImps, waitForExec } from '../lib/imps';
import { runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { buildStats } from '../lib/stats';
import { writeMetric } from '../lib/write-metric';

const prefix = setupSuite('scale');

// restart re-adopts a full house when it runs after this suite
const leaveForRestart = config.runSuites.includes('restart');

const FILL_SCRIPT =
  `mkdir -p /run/fill && mount -t tmpfs -o size=${String(config.scaleFillMib + 16)}m tmpfs /run/fill && ` +
  `dd if=/dev/urandom of=/run/fill/blob bs=1M count=${String(config.scaleFillMib)} 2>/dev/null`;

// "<MiB> <count>": PSS over every Firecracker process in the container, a
// figure that does not come from impd
const FIRECRACKER_PSS_SCRIPT = `
kib=0; count=0
for pid in $(pgrep -x firecracker); do
  v=$(awk '/^Pss:/ { print $2 }' /proc/$pid/smaps_rollup 2>/dev/null)
  kib=$((kib + \${v:-0})); count=$((count + 1))
done
echo $((kib / 1024)) $count`;

interface BudgetSample {
  readonly ramUsedMib: number;
  readonly awake: number;
  readonly firecrackerPssMib: number;
}

interface BudgetMonitor {
  readonly samples: readonly BudgetSample[];
  readonly stop: () => Promise<void>;
}

async function readBudgetSample(): Promise<BudgetSample> {
  const info = await readInfo();
  const pss = await runInContainer(['sh', '-c', FIRECRACKER_PSS_SCRIPT]);

  const [pssMib] = pss.stdout.trim().split(' ');

  return {
    ramUsedMib: info.ramUsedMib,
    awake: info.awakeCount,
    firecrackerPssMib: Number(pssMib),
  };
}

// samples impd's RAM figure and Firecracker's PSS about every 0.5 s
function startBudgetMonitor(): BudgetMonitor {
  const samples: BudgetSample[] = [];
  const state = { running: true };

  const loop = (async () => {
    while (state.running) {
      try {
        const sample = await readBudgetSample();

        samples.push(sample);
      } catch {
        // a sample lost to a busy impd is not a budget violation
      }

      await Bun.sleep(500);
    }
  })();

  return {
    samples,
    stop: async () => {
      state.running = false;

      await loop;
    },
  };
}

function findViolations(samples: readonly BudgetSample[]): readonly BudgetSample[] {
  return samples.filter(
    (sample) =>
      sample.ramUsedMib > config.ramBudgetMib || sample.firecrackerPssMib > config.ramBudgetMib,
  );
}

function buildName(index: number): string {
  return `${prefix}${String(index).padStart(2, '0')}`;
}

// creates one scale imp and fills its tmpfs; returns the `imp new` time
async function createFilledImp(name: string): Promise<number> {
  if (!leaveForRestart) {
    registerImp(name);
  }

  const started = Date.now();

  await runImp('new', name, '--image', 'e2e-tiny', '--memory', String(config.scaleMemoryMib));

  const ms = Date.now() - started;

  await waitForExec(name);
  await runShellInImp(name, FILL_SCRIPT);

  return ms;
}

async function readPerImpMib(usedBefore: number): Promise<number> {
  const row = await requireImp(buildName(1));

  if (row.ramMib !== undefined) {
    return row.ramMib;
  }

  const info = await readInfo();

  return info.ramUsedMib - usedBefore;
}

test(`${String(config.scaleCount)} imps stay inside the RAM budget and wake on request`, async () => {
  const start = await readInfo();

  expect(start.ramBudgetMib).toBe(config.ramBudgetMib);
  expect(config.scaleMemoryMib * 2).toBeLessThanOrEqual(config.ramBudgetMib);

  const monitor = startBudgetMonitor();
  const createMs: number[] = [];
  const wakeMs: number[] = [];
  let sleepingAfterCreate = 0;

  try {
    const firstMs = await createFilledImp(buildName(1));

    createMs.push(firstMs);

    await Bun.sleep(3000);

    const perImp = await readPerImpMib(start.ramUsedMib);

    const fit = Math.floor(config.ramBudgetMib / perImp);

    expect(perImp).toBeGreaterThan(0);

    console.log(
      `    per-imp RAM ${String(perImp)} MiB (--memory ${String(config.scaleMemoryMib)}, ` +
        `${String(config.scaleFillMib)} MiB filled); about ${String(fit)} fit in ${String(config.ramBudgetMib)} MiB`,
    );

    writeMetric('scale', {
      perImpRamMib: perImp,
      fitInBudget: fit,
      count: config.scaleCount,
      memoryMib: config.scaleMemoryMib,
      fillMib: config.scaleFillMib,
    });

    for (let index = 2; index <= config.scaleCount; index++) {
      const ms = await createFilledImp(buildName(index));

      createMs.push(ms);

      expect(findViolations(monitor.samples)).toBeEmpty();
    }

    const rows = await listImps();

    const scaleImps = rows.filter((row) => row.name.startsWith(prefix));
    const sleeping = scaleImps.filter((row) => row.state === 'sleeping');
    const running = scaleImps.filter((row) => row.state === 'running');

    console.log(
      `    ${String(scaleImps.length)} exist: ${String(running.length)} running, ${String(sleeping.length)} sleeping`,
    );

    expect(scaleImps).toHaveLength(config.scaleCount);
    expect(sleeping).not.toBeEmpty();

    sleepingAfterCreate = sleeping.length;

    // LRU: every sleeping imp was last active no later than every running one
    const lastSlept = Math.max(...sleeping.map((row) => Date.parse(row.lastActiveAt)));
    const firstAwake = Math.min(...running.map((row) => Date.parse(row.lastActiveAt)));

    expect(lastSlept).toBeLessThanOrEqual(firstAwake);

    // exec wakes the least recently active imp the governor slept, memory
    // and all: its tmpfs fill is still there, and RAM stays in budget
    const [lru] = sleeping.toSorted(
      (a, b) => Date.parse(a.lastActiveAt) - Date.parse(b.lastActiveAt),
    );

    const fillMib = await runShellInImp(lru?.name ?? '', 'du -m /run/fill/blob | cut -f1');

    expect(Number(fillMib)).toBe(config.scaleFillMib);

    await Bun.sleep(3000);

    expect(findViolations(monitor.samples)).toBeEmpty();

    // each request to a sleeping imp must wake it within the budget
    for (let index = 1; index <= config.scaleCount; index++) {
      const name = buildName(index);

      const state = await readState(name);

      const started = Date.now();

      const body = await getThroughProxy(name);

      if (state === 'sleeping') {
        wakeMs.push(Date.now() - started);
      }

      expect(body).toBe('e2e-tiny-ok');
    }

    console.log(`    woke ${String(wakeMs.length)} sleeping imps by HTTP`);

    expect(wakeMs).not.toBeEmpty();

    // an imp that cannot fit even after sleeping everything else
    const huge = `${prefix}huge`;
    const memory = String(config.ramBudgetMib + 1024);

    registerImp(huge);

    const rejected = await tryImp(['new', huge, '--image', 'e2e-tiny', '--memory', memory]);
    const leftBehind = await findImp(huge);

    await removeImps(huge);

    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr).toContain('RAM_BUDGET_EXCEEDED');
    expect(leftBehind).toBeUndefined();

    await Bun.sleep(2000);
  } finally {
    await monitor.stop();
  }

  expect(findViolations(monitor.samples)).toBeEmpty();

  const maxUsed = Math.max(...monitor.samples.map((sample) => sample.ramUsedMib));
  const maxPss = Math.max(...monitor.samples.map((sample) => sample.firecrackerPssMib));
  const maxAwake = Math.max(...monitor.samples.map((sample) => sample.awake));

  console.log(
    `    budget held over ${String(monitor.samples.length)} samples: max ramUsedMib ${String(maxUsed)}, ` +
      `max Firecracker PSS ${String(maxPss)}, max awake ${String(maxAwake)}`,
  );

  writeMetric('scaleBudget', {
    maxRamUsedMib: maxUsed,
    maxFirecrackerPssMib: maxPss,
    maxAwake,
    samples: monitor.samples.length,
    sleepingAfterCreate,
  });

  writeMetric('createMs', buildStats(createMs));
  writeMetric('wakeMs', buildStats(wakeMs));
});
