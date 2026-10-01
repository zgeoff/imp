import { expect, test } from 'bun:test';
import { config } from '../lib/config';
import { getThroughProxy, readOkBody, sendImpPortRequest, sendProxyRequest } from '../lib/http';
import {
  assertState,
  readInfo,
  readState,
  requireImp,
  runImp,
  runInImp,
  runShellInImp,
} from '../lib/imp-cli';
import { createImp, holdImp } from '../lib/imps';
import { checkFirecrackerRunning } from '../lib/instance';
import type { MemoryProof } from '../lib/memory-proof';
import { checkMemoryProof, startMemoryProof } from '../lib/memory-proof';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';
import { openProxySocket, sendAndReceive, stopSocket } from '../lib/websocket';
import { writeMetric } from '../lib/write-metric';

const prefix = setupSuite('sleep');
const name = `${prefix}mem`;
const wsName = `${prefix}ws`;

// the idle timeout plus a sweep of the idle loop
const ASLEEP_WITHIN_MS = (config.idleTimeoutS + 15) * 1000;

// long enough that only activity keeps an imp awake
const PAST_IDLE_MS = (config.idleTimeoutS + 6) * 1000;
let proof: MemoryProof;

function waitAsleep(imp: string, timeoutMs = ASLEEP_WITHIN_MS): Promise<void> {
  return waitFor(`${imp} to sleep`, () => assertState(imp, 'sleeping'), { timeoutMs });
}

async function readRamMib(imp: string): Promise<number> {
  const row = await requireImp(imp);

  return row.ramMib ?? 0;
}

test('an idle imp sleeps by itself, frees its RAM and an HTTP request wakes it intact', async () => {
  await createImp(name, '--image', 'e2e-bare', '--memory', '512');

  proof = await startMemoryProof(name);

  const row = await requireImp(name);
  const firecrackerUp = await checkFirecrackerRunning(row.id);

  expect(firecrackerUp).toBeTrue();

  // let the RAM measurement catch up with the proof's httpd
  await Bun.sleep(3000);

  const before = await readInfo();

  let started = Date.now();

  await waitAsleep(name, (config.idleTimeoutS * 3 + 60) * 1000);

  writeMetric('idleToSleepMs', Date.now() - started);

  await waitFor(`Firecracker for ${name} to exit`, async () => {
    const running = await checkFirecrackerRunning(row.id);

    expect(running).toBeFalse();
  });

  const after = await readInfo();

  console.log(
    `    ramUsedMib ${String(before.ramUsedMib)} -> ${String(after.ramUsedMib)}, ` +
      `awakeCount ${String(before.awakeCount)} -> ${String(after.awakeCount)}`,
  );

  expect(after.ramUsedMib).toBeLessThan(before.ramUsedMib);
  expect(after.awakeCount).toBeLessThan(before.awakeCount);

  writeMetric('sleepFreedMib', before.ramUsedMib - after.ramUsedMib);

  started = Date.now();

  const response = await sendProxyRequest(name);
  const body = await response.text();

  writeMetric('wakeOnHttpMs', Date.now() - started);

  const state = await readState(name);

  expect(response.status).toBe(200);
  expect(body.trim()).toBe(proof.token);
  expect(Number(response.headers.get('x-imp-wake-ms'))).toBeGreaterThan(0);
  expect(state).toBe('running');

  await checkMemoryProof(proof);
});

test('a finished request does not keep an imp awake; an exec session and a hold do', async () => {
  await getThroughProxy(name);
  await waitAsleep(name);

  // an exec that outlasts the idle timeout holds the imp awake while it runs
  await runInImp(name, 'sleep', String(config.idleTimeoutS + 6));

  const afterExec = await readState(name);

  expect(afterExec).toBe('running');

  await waitAsleep(name);
  await runImp('hold', name, '1m');

  await Bun.sleep(PAST_IDLE_MS);

  const whileHeld = await readState(name);

  expect(whileHeld).toBe('running');

  await runImp('hold', name, '0');
  await waitAsleep(name);
  await checkMemoryProof(proof);
});

test('imp sleep and imp wake keep memory and the guest clock catches up', async () => {
  await runImp('wake', name);
  await runImp('sleep', name);

  const slept = await readState(name);

  expect(slept).toBe('sleeping');

  // long enough that a guest clock that froze while asleep would show it
  await Bun.sleep(5000);

  await runImp('wake', name);

  const woken = await readState(name);

  expect(woken).toBe('running');

  await checkMemoryProof(proof);

  const guestS = await runInImp(name, 'date', '+%s');

  expect(Math.abs(Number(guestS) - Date.now() / 1000)).toBeLessThan(3);
});

test("a request to the imp's own port wakes it too", async () => {
  await runImp('sleep', name);

  const row = await requireImp(name);
  const body = await readOkBody(sendImpPortRequest(row.slot));
  const state = await readState(name);

  expect(body).toBe(proof.token);
  expect(state).toBe('running');
});

test('memory the guest frees goes back to the host', async () => {
  await holdImp(name);

  const baseline = await waitFor('a RAM reading', async () => {
    const ram = await readRamMib(name);

    expect(ram).toBeGreaterThan(0);

    return ram;
  });

  await runShellInImp(
    name,
    'mkdir -p /run/fill && mount -t tmpfs -o size=320m tmpfs /run/fill && ' +
      'dd if=/dev/urandom of=/run/fill/blob bs=1M count=300 2>/dev/null',
  );

  await waitFor(`${name} RAM to grow`, async () => {
    const ram = await readRamMib(name);

    expect(ram).toBeGreaterThan(baseline + 250);
  });

  await runShellInImp(name, 'rm /run/fill/blob && umount /run/fill');

  // free page reporting hands the pages back within seconds
  await waitFor(`${name} RAM to shrink`, async () => {
    const ram = await readRamMib(name);

    expect(ram).toBeLessThan(baseline + 100);
  });
});

test('the proxy answers 404 for an unknown imp and 502 when nothing listens', async () => {
  const unknown = await sendProxyRequest(`${prefix}nope`);

  expect(unknown.status).toBe(404);

  await runInImp(name, 'pkill', '-x', 'httpd');

  const refused = await sendProxyRequest(name);

  expect(refused.status).toBe(502);
});

test('WebSockets relay through the proxy, keep an imp awake and wake it', async () => {
  await createImp(wsName, '--image', 'e2e-ws', '--memory', '512');

  await waitFor(`${wsName} to serve HTTP`, async () => {
    const body = await getThroughProxy(wsName);

    expect(body).toBe('e2e-ws-ok');
  });

  let socket = await openProxySocket(wsName);
  const hello = await sendAndReceive(socket, 'hello');

  expect(hello).toBe('echo hello');

  // an open socket counts as activity
  await Bun.sleep(PAST_IDLE_MS);

  const whileOpen = await readState(wsName);
  const still = await sendAndReceive(socket, 'still here');

  expect(whileOpen).toBe('running');
  expect(still).toBe('echo still here');

  await stopSocket(socket);
  await waitAsleep(wsName);

  const started = Date.now();

  socket = await openProxySocket(wsName);

  const woken = await sendAndReceive(socket, 'woken');

  writeMetric('wakeOnWebSocketMs', Date.now() - started);

  const state = await readState(wsName);

  expect(woken).toBe('echo woken');
  expect(state).toBe('running');

  await stopSocket(socket);
});

test('a cold boot loses what only memory held', async () => {
  await runImp('stop', name);
  await runImp('start', name);

  const token = await runShellInImp(name, 'cat /run/proof/index.html 2>/dev/null || echo none');

  expect(token).toBe('none');
});
