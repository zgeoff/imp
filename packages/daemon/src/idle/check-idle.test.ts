import { expect, test } from 'bun:test';
import { checkIdle } from './check-idle';
import type { IdleSignals } from './check-idle';

const QUIET: IdleSignals = {
  execSessions: 0,
  proxyConnections: 0,
  sshConnections: 0,
  tunnelConnections: 0,
  tcpEstablished: 0,
  cpuPercent: 1,
  holdUntil: null,
  lastActiveAt: 0,
};

const SETTINGS = { now: 60_000, idleTimeoutMs: 60_000, cpuPercent: 10 };

test('it sleeps an imp that has been quiet for the timeout', () => {
  expect(checkIdle(QUIET, SETTINGS)).toEqual({ activeReason: null, sleep: true });

  expect(checkIdle(QUIET, { ...SETTINGS, now: 59_999 })).toEqual({
    activeReason: null,
    sleep: false,
  });
});

test('it keeps an imp awake for each kind of activity', () => {
  const cases: [Partial<IdleSignals>, string][] = [
    [{ holdUntil: 60_001 }, 'hold'],
    [{ execSessions: 1 }, 'exec'],
    [{ proxyConnections: 2 }, 'proxy'],
    [{ sshConnections: 1 }, 'ssh'],
    [{ tunnelConnections: 1 }, 'tunnel'],
    [{ tcpEstablished: 1 }, 'tcp'],
    [{ cpuPercent: 25 }, 'cpu'],
  ];

  for (const [change, reason] of cases) {
    expect(checkIdle({ ...QUIET, ...change }, SETTINGS)).toEqual({
      activeReason: reason,
      sleep: false,
    });
  }
});

test('it ignores an expired hold and a first CPU sample', () => {
  const decision = checkIdle({ ...QUIET, holdUntil: 59_000, cpuPercent: null }, SETTINGS);

  expect(decision).toEqual({ activeReason: null, sleep: true });
});
