import { expect, test } from 'bun:test';
import type { Imp } from '@imp/api';
import { formatCpuUse } from '../format-output';
import { formatTop, readCpuArgs } from './cpu';

const IMP: Imp = {
  id: 'id',
  name: 'idle',
  image: 'base',
  state: 'running',
  vcpus: 2,
  memoryMib: 2048,
  diskMib: 8192,
  ip: '10.66.0.2',
  slot: 0,
  port: 20_000,
  httpPort: 8080,
  url: 'http://idle.imp.localhost:7080',
  createdAt: new Date(0),
  lastActiveAt: new Date(0),
  ramMib: 300,
  cpu: { limit: null, weight: 100 },
  resources: {
    wakeCount: 3,
    awakeMs: 90_000,
    sample: {
      measuredAt: new Date(0),
      since: new Date(0),
      cpuPercent: 2,
      cpuThrottledMs: 0,
      netRxBytes: 2048,
      netTxBytes: 10,
    },
  },
};

test('the CPU column shows the last sample over the limit', () => {
  expect(formatCpuUse(IMP)).toBe('2%');
  expect(formatCpuUse({ ...IMP, cpu: { limit: 1.5, weight: 100 } })).toBe('2% / 1.5');

  expect(formatCpuUse({ ...IMP, state: 'sleeping', resources: { wakeCount: 0, awakeMs: 0 } })).toBe(
    '-',
  );
});

test('imp top lists the busiest imp first, with traffic, wakes and awake time', () => {
  const busy: Imp = {
    ...IMP,
    name: 'busy',
    cpu: { limit: 0.5, weight: 200 },
    resources: {
      wakeCount: 0,
      awakeMs: 7_200_000,
      sample: {
        measuredAt: new Date(0),
        since: new Date(0),
        cpuPercent: 50,
        cpuThrottledMs: 4000,
        netRxBytes: 2048,
        netTxBytes: 10,
      },
    },
  };

  const rows = formatTop([IMP, busy])
    .split('\n')
    .map((row) => row.split(/\s{2,}/));

  expect(rows).toEqual([
    ['NAME', 'STATE', 'CPU', 'WEIGHT', 'THROTTLED', 'RAM', 'NET IN', 'NET OUT', 'WAKES', 'AWAKE'],
    ['busy', 'running', '50% / 0.5', '200', '4s', '300 MiB', '2.0 KiB', '10 B', '0', '2h'],
    ['idle', 'running', '2%', '100', '0s', '300 MiB', '2.0 KiB', '10 B', '3', '90s'],
  ]);
});

test('imp set and imp new read the CPU flags', () => {
  expect(readCpuArgs({ 'cpu-limit': 'none', 'cpu-weight': '50' })).toEqual({
    cpuLimit: null,
    cpuWeight: 50,
  });

  expect(readCpuArgs({})).toEqual({});
});
