import { expect, test } from 'bun:test';
import { checkIdle } from './check-idle';

test('it sleeps an imp that has been quiet for the timeout', () => {
  expect(
    checkIdle(
      {
        execSessions: 0,
        proxyConnections: 0,
        sshConnections: 0,
        tunnelConnections: 0,
        tcpEstablished: 0,
        cpuPercent: 1,
        holdUntil: null,
        lastActiveAt: 0,
      },
      { now: 60_000, idleTimeoutMs: 60_000, cpuPercent: 10 },
    ),
  ).toStrictEqual({ activeReason: null, sleep: true });
});

test('it keeps a quiet imp awake until the timeout has passed', () => {
  expect(
    checkIdle(
      {
        execSessions: 0,
        proxyConnections: 0,
        sshConnections: 0,
        tunnelConnections: 0,
        tcpEstablished: 0,
        cpuPercent: 1,
        holdUntil: null,
        lastActiveAt: 0,
      },
      { now: 59_999, idleTimeoutMs: 60_000, cpuPercent: 10 },
    ),
  ).toStrictEqual({ activeReason: null, sleep: false });
});

test.each([
  ['a hold', { holdUntil: 60_001 }, 'hold'],
  ['an exec session', { execSessions: 1 }, 'exec'],
  ['proxied connections', { proxyConnections: 2 }, 'proxy'],
  ['an SSH connection', { sshConnections: 1 }, 'ssh'],
  ['a tunnel connection', { tunnelConnections: 1 }, 'tunnel'],
  ['an established TCP connection', { tcpEstablished: 1 }, 'tcp'],
  ['CPU above the threshold', { cpuPercent: 25 }, 'cpu'],
])('it keeps an imp awake for %s', (_label, change, reason) => {
  expect(
    checkIdle(
      {
        execSessions: 0,
        proxyConnections: 0,
        sshConnections: 0,
        tunnelConnections: 0,
        tcpEstablished: 0,
        cpuPercent: 1,
        holdUntil: null,
        lastActiveAt: 0,
        ...change,
      },
      { now: 60_000, idleTimeoutMs: 60_000, cpuPercent: 10 },
    ),
  ).toStrictEqual({ activeReason: reason, sleep: false });
});

test('it ignores an expired hold', () => {
  expect(
    checkIdle(
      {
        execSessions: 0,
        proxyConnections: 0,
        sshConnections: 0,
        tunnelConnections: 0,
        tcpEstablished: 0,
        cpuPercent: 1,
        holdUntil: 59_000,
        lastActiveAt: 0,
      },
      { now: 60_000, idleTimeoutMs: 60_000, cpuPercent: 10 },
    ),
  ).toStrictEqual({ activeReason: null, sleep: true });
});

test('it ignores a first CPU sample', () => {
  expect(
    checkIdle(
      {
        execSessions: 0,
        proxyConnections: 0,
        sshConnections: 0,
        tunnelConnections: 0,
        tcpEstablished: 0,
        cpuPercent: null,
        holdUntil: null,
        lastActiveAt: 0,
      },
      { now: 60_000, idleTimeoutMs: 60_000, cpuPercent: 10 },
    ),
  ).toStrictEqual({ activeReason: null, sleep: true });
});
