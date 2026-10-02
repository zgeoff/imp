import { expect, test } from 'bun:test';
import { resolveImageName } from '../lib/fixtures';
import { assertState, readInfo, requireImp, runImp, runShellInImp } from '../lib/imp-cli';
import { createImp, holdImp, waitForExec } from '../lib/imps';
import { runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

const prefix = setupSuite('cpu');
const TINY = resolveImageName('e2e-tiny');
const name = `${prefix}box`;

// one guest core busy for this long, against a limit of half a core
const BUSY_S = 5;

// an upper bound only: a loaded host may give the VM less, never more
const MAX_SHARE = 0.55;

async function readCgroupDir(): Promise<string> {
  const row = await requireImp(name);

  return `/sys/fs/cgroup/imps/${row.id}`;
}

async function readContainerFile(path: string): Promise<string> {
  const result = await runInContainer(['cat', path]);

  if (result.exitCode !== 0) {
    throw new Error(`cat ${path} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }

  return result.stdout;
}

async function readCpuStat(): Promise<{ usageUsec: number; throttledUsec: number }> {
  const dir = await readCgroupDir();
  const text = await readContainerFile(`${dir}/cpu.stat`);

  const readField = (field: string): number =>
    Number(new RegExp(`^${field} (?<value>\\d+)$`, 'mv').exec(text)?.groups?.['value'] ?? NaN);

  return { usageUsec: readField('usage_usec'), throttledUsec: readField('throttled_usec') };
}

// Runs one busy guest core for BUSY_S and returns the VM's CPU over host
// wall time, in cores, from its cgroup's cpu.stat.
async function runBusyLoop(): Promise<{ share: number; throttledUsec: number }> {
  const before = await readCpuStat();

  const started = performance.now();

  await runShellInImp(
    name,
    `end=$(($(date +%s) + ${String(BUSY_S)})); while [ "$(date +%s)" -lt "$end" ]; do :; done`,
  );

  const wallUsec = (performance.now() - started) * 1000;

  const after = await readCpuStat();

  return {
    share: (after.usageUsec - before.usageUsec) / wallUsec,
    throttledUsec: after.throttledUsec - before.throttledUsec,
  };
}

// A host whose Docker does not hand the cpu controller to the container
// cannot limit CPU: the suite skips there and says why. CI must enforce, so
// there it fails instead, and a green run proves the limits hold.
const info = await readInfo();

const isEnforced = info.cpu?.limitsEnforced === true;
const isCi = (process.env['CI'] ?? '') !== '';
const shouldSkip = !isEnforced && !isCi;

if (shouldSkip) {
  console.warn(
    'cpu: skipped: impd reports CPU limits not enforced; this Docker does not delegate the cpu controller to a private cgroup namespace',
  );
}

test('docker exec still works after the cgroup move', async () => {
  // the entrypoint moved every process out of the root cgroup when it could:
  // docker exec still lands somewhere it may run
  const exec = await runInContainer(['true']);

  expect(exec.exitCode).toBe(0);
});

test.skipIf(shouldSkip)('impd enforces CPU limits', () => {
  expect(info.cpu?.limitsEnforced).toBeTrue();
});

test.skipIf(shouldSkip)('a limit of half a core holds a busy guest under it', async () => {
  await createImp(name, '--image', TINY, '--cpu-limit', '0.5');
  await holdImp(name);

  const dir = await readCgroupDir();
  const cpuMax = await readContainerFile(`${dir}/cpu.max`);

  expect(cpuMax.trim()).toBe('50000 100000');

  const procs = await readContainerFile(`${dir}/cgroup.procs`);

  expect(procs.trim()).not.toBe('');

  const busy = await runBusyLoop();

  writeMetric('cpuLimitedShare', busy.share);

  expect(busy.share).toBeLessThanOrEqual(MAX_SHARE);
  expect(busy.throttledUsec).toBeGreaterThan(0);
});

test.skipIf(shouldSkip)('the limit holds again after a sleep and a wake', async () => {
  await runImp('sleep', name);
  await assertState(name, 'sleeping');
  await runImp('wake', name);
  await waitForExec(name);

  const dir = await readCgroupDir();
  const cpuMax = await readContainerFile(`${dir}/cpu.max`);

  expect(cpuMax.trim()).toBe('50000 100000');

  const busy = await runBusyLoop();

  expect(busy.share).toBeLessThanOrEqual(MAX_SHARE);

  const row = await requireImp(name);

  expect(row.resources?.wakeCount).toBe(1);
});

test.skipIf(shouldSkip)('imp set changes the limit of a running imp at once', async () => {
  await runImp('set', name, '--cpu-limit', '0.25', '--cpu-weight', '50');

  const dir = await readCgroupDir();
  const cpuMax = await readContainerFile(`${dir}/cpu.max`);
  const cpuWeight = await readContainerFile(`${dir}/cpu.weight`);

  expect(cpuMax.trim()).toBe('25000 100000');
  expect(cpuWeight.trim()).toBe('50');

  const busy = await runBusyLoop();

  expect(busy.share).toBeLessThanOrEqual(0.3);

  await runImp('set', name, '--cpu-limit', 'none');

  const unlimited = await readContainerFile(`${dir}/cpu.max`);

  expect(unlimited.trim()).toBe('max 100000');
});

test.skipIf(shouldSkip)('imp top prints the imp with its sample', async () => {
  await waitFor(`a resource sample for ${name}`, async () => {
    const row = await requireImp(name);

    expect(row.resources?.sample).toBeDefined();
  });

  const top = await runImp('top', '--once');

  const line = top.split('\n').find((candidate) => candidate.startsWith(name));

  expect(line).toBeDefined();
  expect(line).toContain('running');
});
