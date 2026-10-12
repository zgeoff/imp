import { expect, onTestFinished, test } from 'bun:test';
import { waitAwakePastIdle } from '../lib/awake-past-idle';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { readOkBody, sendImpPortRequest, sendProxyRequest } from '../lib/http';
import {
  assertState,
  createInstanceClient,
  readInfo,
  readState,
  requireImp,
  runImp,
  runInImp,
  runShellInImp,
  startImp,
} from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import { checkFirecrackerRunning } from '../lib/instance';
import { checkMemoryProof, startMemoryProof } from '../lib/memory-proof';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// Sleep and wake of an e2e-bare imp (docs/architecture/sleep-and-wake.md):
// a memory proof (lib/memory-proof.ts) shows what only guest memory holds.

// one stack for every release, so an exec stops before its imp goes
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('sleep'), stack, client };
}

test('it sleeps an idle imp by itself, wakes it intact on a request, and keeps it awake only while something is active', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}mem`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);

  const proof = await startMemoryProof(name);
  const row = await requireImp(name);
  const firecrackerUp = await checkFirecrackerRunning(row.id);

  expect(firecrackerUp).toBeTrue();

  // impd's sampler has measured the imp, so the RAM it uses counts
  await waitFor(`a RAM reading of ${name}`, async () => {
    const sampled = await requireImp(name);

    if ((sampled.ramMib ?? 0) <= 0) {
      throw new Error(`${name} has no RAM reading yet`);
    }
  });

  const before = await readInfo();

  // an idle imp sleeps by itself and frees its RAM
  const idleFrom = Date.now();

  await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'), {
    timeoutMs: (config.idleTimeoutS * 3 + 60) * 1000,
  });

  writeMetric('idleToSleepMs', Date.now() - idleFrom);

  await waitFor(`Firecracker for ${name} to exit`, async () => {
    const running = await checkFirecrackerRunning(row.id);

    if (running) {
      throw new Error('Firecracker still runs');
    }
  });

  const after = await readInfo();

  writeMetric('sleepFreedMib', before.ramUsedMib - after.ramUsedMib);

  expect(after.ramUsedMib).toBeLessThan(before.ramUsedMib);
  expect(after.awakeCount).toBeLessThan(before.awakeCount);

  // an HTTP request wakes it intact
  const requested = Date.now();

  const response = await sendProxyRequest(name);
  const body = await response.text();

  writeMetric('wakeOnHttpMs', Date.now() - requested);

  const wokenByRequest = await readState(name);

  expect(response.status).toBe(200);
  expect(body.trim()).toBe(proof.token);
  expect(Number(response.headers.get('x-imp-wake-ms'))).toBeGreaterThan(0);
  expect(wokenByRequest).toBe('running');

  await checkMemoryProof(proof);

  // a finished request does not keep it awake
  await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'), {
    timeoutMs: (config.idleTimeoutS + 15) * 1000,
  });

  // an exec session holds it awake while it runs
  const exec = await startImp(['exec', name, '--', 'sleep', '3600']);

  ctx.stack.defer(async () => {
    exec.kill();

    await exec.exited;
  });

  const execFrom = Date.now();

  await waitAwakePastIdle(name, execFrom);

  exec.kill();

  await exec.exited;

  await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'), {
    timeoutMs: (config.idleTimeoutS + 15) * 1000,
  });

  // a hold does too
  await runImp('hold', name, '1m');

  const heldFrom = Date.now();

  await waitAwakePastIdle(name, heldFrom);
  await runImp('hold', name, '0');

  await waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'), {
    timeoutMs: (config.idleTimeoutS + 15) * 1000,
  });

  await checkMemoryProof(proof);

  // imp sleep and imp wake keep memory, and the guest clock catches up
  await runImp('sleep', name);

  const slept = await readState(name);

  // the time asleep is the contract: a guest clock that froze while asleep
  // would be this far behind after the wake
  await Bun.sleep(5000);

  await runImp('wake', name);

  const woken = await readState(name);

  await checkMemoryProof(proof);

  const guestS = await runInImp(name, 'date', '+%s');

  expect(slept).toBe('sleeping');
  expect(woken).toBe('running');
  expect(Math.abs(Number(guestS) - Date.now() / 1000)).toBeLessThan(3);

  // a request to the imp's own port wakes it too
  await runImp('sleep', name);

  const byPort = await readOkBody(sendImpPortRequest(row.slot));
  const wokenByPort = await readState(name);

  expect(byPort).toBe(proof.token);
  expect(wokenByPort).toBe('running');
});

test('it gives memory the guest frees back to the host', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}free`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '512');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await holdImp(name);

  const baseline = await waitFor('a RAM reading', async () => {
    const sampled = await requireImp(name);

    if ((sampled.ramMib ?? 0) <= 0) {
      throw new Error(`${name} has no RAM reading yet`);
    }

    return sampled.ramMib ?? 0;
  });

  await runShellInImp(
    name,
    'mkdir -p /run/fill && mount -t tmpfs -o size=320m tmpfs /run/fill && ' +
      'dd if=/dev/urandom of=/run/fill/blob bs=1M count=300 2>/dev/null',
  );

  const grown = await waitFor(`${name} RAM to grow`, async () => {
    const sampled = await requireImp(name);

    const ram = sampled.ramMib ?? 0;

    if (ram <= baseline + 250) {
      throw new Error(`${name} uses ${String(ram)} MiB`);
    }

    return ram;
  });

  await runShellInImp(name, 'rm /run/fill/blob && umount /run/fill');

  // free page reporting hands the pages back within seconds
  const shrunk = await waitFor(`${name} RAM to shrink`, async () => {
    const sampled = await requireImp(name);

    const ram = sampled.ramMib ?? 0;

    if (ram >= baseline + 100) {
      throw new Error(`${name} uses ${String(ram)} MiB`);
    }

    return ram;
  });

  expect(grown).toBeGreaterThan(baseline + 250);
  expect(shrunk).toBeLessThan(baseline + 100);
});

test('it loses what only memory held on a cold boot', async () => {
  const ctx = await setupTest();

  const name = `${ctx.prefix}cold`;

  await runImp('new', name, '--image', resolveImageName('e2e-bare'), '--memory', '256');

  registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

  await waitForExec(name);
  await startMemoryProof(name);
  await runImp('stop', name);
  await runImp('start', name);

  const token = await runShellInImp(name, 'cat /run/proof/index.html 2>/dev/null || echo none');

  expect(token).toBe('none');
});
