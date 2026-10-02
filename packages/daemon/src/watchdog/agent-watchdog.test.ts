import { expect, test } from 'bun:test';
import type { ImpRecord } from '../db/imps';
import { createAgentWatchdog } from './agent-watchdog';
import type { WatchdogAction } from './agent-watchdog';

const IMP = { id: 'i1', name: 'dev' } as const satisfies Partial<ImpRecord>;

// the watchdog reads only the id and the name
function buildImp(): ImpRecord {
  return {
    ...IMP,
    imageId: 'img',
    state: 'running',
    vcpus: 1,
    memoryMib: 512,
    slot: 0,
    ip: '10.66.0.2',
    createdAt: new Date(0),
    lastActiveAt: new Date(0),
    sleptAt: null,
    holdUntil: null,
    error: null,
    pid: 1,
    firecrackerVersion: null,
    httpPort: 8080,
    diskBytes: 1024 ** 3,
    isDiskGrowPending: false,
    publicAuth: null,
    cpu: { limit: null, weight: 100 },
    wakeCount: 0,
    awakeMs: 0,
    awakeSince: null,
    isIdentityResetPending: false,
  };
}

function setupWatchdog(action: WatchdogAction) {
  const clock = { now: 0 };
  const logs: string[] = [];
  const recovered: number[] = [];
  const agent = { answersPing: false, lockFree: true };

  const watchdog = createAgentWatchdog({
    timeoutMs: 60_000,
    action,
    now: () => clock.now,
    log: (message) => {
      logs.push(message);
    },
    confirmSilent: () => Promise.resolve(!agent.answersPing),
    recover: () => {
      if (agent.lockFree) {
        recovered.push(clock.now);
      }

      return Promise.resolve(agent.lockFree);
    },
  });

  // one idle-loop look `afterMs` later, and whatever it starts
  const runLook = async (answered: boolean, afterMs = 0) => {
    clock.now += afterMs;

    watchdog.observe(buildImp(), answered);

    await watchdog.settle();
  };

  return { watchdog, clock, logs, recovered, agent, runLook };
}

test('a silent agent is reported once, past the timeout and a failed ping', async () => {
  const host = setupWatchdog('report');

  await host.runLook(false);
  await host.runLook(false, 30_000);

  const early = host.watchdog.readSilentSince(IMP.id);

  await host.runLook(false, 30_000);
  await host.runLook(false, 2000);

  expect(early).toBeNull();
  expect(host.watchdog.readSilentSince(IMP.id)).toEqual(new Date(0));
  expect(host.recovered).toEqual([]);

  expect(host.logs).toEqual([
    'impd: dev: the agent has not answered for 60s; its VM still runs (watchdog: report)',
  ]);
});

test('an agent that answers the longer ping, or the idle loop again, is not silent', async () => {
  const host = setupWatchdog('report');

  host.agent.answersPing = true;

  await host.runLook(false);
  await host.runLook(false, 61_000);

  const afterPing = host.watchdog.readSilentSince(IMP.id);

  host.agent.answersPing = false;

  await host.runLook(false, 1000);
  await host.runLook(false, 61_000);
  await host.runLook(true, 1000);

  expect(afterPing).toBeNull();
  expect(host.watchdog.readSilentSince(IMP.id)).toBeNull();
  expect(host.logs.at(-1)).toBe('impd: dev: the agent answers again');
});

test('restarts back off, then stop at three an hour', async () => {
  const host = setupWatchdog('restart');

  // silent for good: each restart's new agent goes silent too
  const runSilence = async (ms: number) => {
    await host.runLook(false);
    await host.runLook(false, ms);
  };

  await runSilence(60_000);
  await runSilence(30_000);
  await runSilence(30_000);
  await runSilence(120_000);
  await runSilence(200_000);
  await runSilence(60_000);

  // 60 s, then 60 s after the first, then 120 s after the second; none after
  expect(host.recovered).toEqual([60_000, 120_000, 240_000]);
  expect(host.logs.filter((line) => line.includes('only reports now'))).toHaveLength(1);
});

test('a restart another operation held off is tried again, and does not count', async () => {
  const host = setupWatchdog('restart');

  host.agent.lockFree = false;

  await host.runLook(false);
  await host.runLook(false, 60_000);

  host.agent.lockFree = true;

  await host.runLook(false, 2000);

  expect(host.recovered).toEqual([62_000]);
});

test('an imp that is held or gone starts its silence over', async () => {
  const host = setupWatchdog('report');

  await host.runLook(false);

  host.clock.now += 50_000;

  host.watchdog.forget(IMP.id);

  await host.runLook(false);
  await host.runLook(false, 20_000);

  expect(host.watchdog.readSilentSince(IMP.id)).toBeNull();
});
