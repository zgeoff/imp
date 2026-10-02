import { afterAll, beforeAll, expect, test } from 'bun:test';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { assertState, runImp, runShellInImp } from '../lib/imp-cli';
import {
  GUEST_SERVERS,
  PAGE,
  openHeldSocket,
  readPage,
  sendRequest,
  startProxy,
} from '../lib/imp-proxy';
import type { RunningProxy } from '../lib/imp-proxy';
import { createImp } from '../lib/imps';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// `imp proxy` and sleep: each case waits out the idle timeout, so these run
// in the acceptance set, not in `fast` with the proxy suite.

const prefix = setupSuite('proxy-wake');
const name = `${prefix}a`;

// the idle timeout plus a sweep of the idle loop
const ASLEEP_WITHIN_MS = (config.idleTimeoutS + 15) * 1000;

// long enough that only activity keeps an imp awake
const PAST_IDLE_MS = (config.idleTimeoutS + 6) * 1000;
let proxy: RunningProxy;

beforeAll(async () => {
  await createImp(name, '--image', resolveImageName('e2e-tiny'), '--memory', '256');
  await runShellInImp(name, GUEST_SERVERS);

  proxy = await startProxy(name, '0:8080', '0:9001', '0:9002');
}, 120_000);

afterAll(async () => {
  const code = await proxy.stop();

  expect(code).toBe(0);
});

function waitAsleep(): Promise<void> {
  return waitFor(`${name} to sleep`, () => assertState(name, 'sleeping'), {
    timeoutMs: ASLEEP_WITHIN_MS,
  });
}

test('an open connection keeps the imp awake, and it sleeps once the connection ends', async () => {
  const held = await openHeldSocket(proxy.ports[1] ?? 0);

  try {
    await Bun.sleep(PAST_IDLE_MS);

    await assertState(name, 'running');
  } finally {
    held.socket.destroy();
  }

  await waitAsleep();
}, 120_000);

test('a connection wakes a sleeping imp', async () => {
  await assertState(name, 'sleeping');

  const started = Date.now();

  const page = await readPage(`http://127.0.0.1:${String(proxy.ports[0])}/`);

  writeMetric('proxyWakeMs', Date.now() - started);

  expect(page).toBe(PAGE);

  await assertState(name, 'running');
});

test('a forced sleep drops open connections, and the next connection wakes the imp', async () => {
  const held = await openHeldSocket(proxy.ports[2] ?? 0);

  await runImp('sleep', name);
  await held.closed;

  await waitFor('the lost notice', () => {
    expect(proxy.readStderr()).toContain(`${name}:9002: the connection in the imp was lost`);
  });

  const reply = await sendRequest(proxy.ports[2] ?? 0, 'again');

  expect(reply).toBe('got 5 bytes\n');

  await assertState(name, 'running');
}, 120_000);
