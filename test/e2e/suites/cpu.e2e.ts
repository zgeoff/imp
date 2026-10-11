import { expect, onTestFinished, test } from 'bun:test';
import { config } from '../lib/config';
import { readContainerFile, readImpCgroupDir, runBusyLoop } from '../lib/cpu-cgroup';
import { resolveImageName } from '../lib/fixtures';
import { assertState, createInstanceClient, readInfo, requireImp, runImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { runInContainer } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// CPU limits (docs/guides/cpu-limits.md) through each imp's cgroup. Where
// Docker does not delegate the cpu controller to a private cgroup namespace,
// impd reports limits not enforced and the limit tests skip; CI must enforce.

// Bun 1.4.2 has no in-body skip, so the skips' probe runs as the file loads
const startInfo = await readInfo();

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('cpu'), stack, client };
}

// the entrypoint moved every process out of the root cgroup when it could
test('it still lands docker exec in a cgroup where it may run after the cgroup move', async () => {
  const exec = await runInContainer(['true']);

  expect(exec.exitCode).toBe(0);
});

test.skipIf(startInfo.cpu?.limitsEnforced !== true && (process.env['CI'] ?? '') === '')(
  'it reports CPU limits as enforced',
  async () => {
    const info = await readInfo();

    expect(info.cpu?.limitsEnforced).toBeTrue();
  },
);

test.skipIf(startInfo.cpu?.limitsEnforced !== true && (process.env['CI'] ?? '') === '')(
  'it holds a busy guest under a limit of half a core, again after a sleep and a wake, and under a limit imp set changes at once',
  async () => {
    const ctx = await setupTest();

    const name = `${ctx.prefix}box`;

    await runImp('new', name, '--image', resolveImageName('e2e-tiny'), '--cpu-limit', '0.5');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

    await waitForExec(name);
    await holdImp(name);

    const dir = await readImpCgroupDir(name);
    const cpuMax = await readContainerFile(`${dir}/cpu.max`);
    const procs = await readContainerFile(`${dir}/cgroup.procs`);

    // one guest core busy for 5 s against half a core: an upper bound only
    const busy = await runBusyLoop(name, 5);

    writeMetric('cpuLimitedShare', busy.share);

    expect(cpuMax.trim()).toBe('50000 100000');
    expect(procs.trim()).not.toBe('');
    expect(busy.share).toBeLessThanOrEqual(0.55);
    expect(busy.throttledUsec).toBeGreaterThan(0);

    await runImp('sleep', name);
    await assertState(name, 'sleeping');
    await runImp('wake', name);
    await waitForExec(name);

    const wokeDir = await readImpCgroupDir(name);
    const wokeCpuMax = await readContainerFile(`${wokeDir}/cpu.max`);
    const wokeBusy = await runBusyLoop(name, 5);
    const woke = await requireImp(name);

    expect(wokeCpuMax.trim()).toBe('50000 100000');
    expect(wokeBusy.share).toBeLessThanOrEqual(0.55);
    expect(woke.resources?.wakeCount).toBe(1);

    await runImp('set', name, '--cpu-limit', '0.25', '--cpu-weight', '50');

    const setCpuMax = await readContainerFile(`${wokeDir}/cpu.max`);
    const setCpuWeight = await readContainerFile(`${wokeDir}/cpu.weight`);
    const setBusy = await runBusyLoop(name, 5);

    expect(setCpuMax.trim()).toBe('25000 100000');
    expect(setCpuWeight.trim()).toBe('50');
    expect(setBusy.share).toBeLessThanOrEqual(0.3);

    await runImp('set', name, '--cpu-limit', 'none');

    const unlimited = await readContainerFile(`${wokeDir}/cpu.max`);

    expect(unlimited.trim()).toBe('max 100000');
  },
);

test.skipIf(startInfo.cpu?.limitsEnforced !== true && (process.env['CI'] ?? '') === '')(
  'it prints the imp in imp top with its sampled throttling and weight',
  async () => {
    const ctx = await setupTest();

    const name = `${ctx.prefix}top`;

    await runImp(
      'new',
      name,
      '--image',
      resolveImageName('e2e-tiny'),
      '--cpu-limit',
      '0.5',
      '--cpu-weight',
      '50',
    );

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

    await waitForExec(name);
    await holdImp(name);

    await waitFor(`a resource sample for ${name}`, async () => {
      const row = await requireImp(name);

      if (row.resources?.sample === undefined) {
        throw new Error(`${name} has no sample yet`);
      }
    });

    const top = await runImp('top', '--once');

    const line = top.split('\n').find((candidate) => candidate.startsWith(`${name} `)) ?? '';

    // NAME STATE CPU WEIGHT THROTTLED ...: a sample fills THROTTLED, which is
    // `-` without one
    const columns = line.split(/\s{2,}/v);

    expect(columns[0]).toBe(name);
    expect(columns[1]).toBe('running');
    expect(columns[3]).toBe('50');
    expect(columns[4]).not.toBe('-');
  },
);
