import { expect, test } from 'bun:test';
import { buildMockImp } from '@imp/api/test-utils/build-mock-imp';
import { runCli } from '../test-utils/start-cli';
import { formatTop, readCpuArgs } from './cpu';

test('#formatTop lists the busiest imp first, with disk use, traffic, wakes and awake time', () => {
  const { diskUsage, ...idle } = buildMockImp({
    name: 'idle',
    state: 'running',
    diskMib: 8192,
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
  });

  const busy = buildMockImp({
    name: 'busy',
    state: 'running',
    diskMib: 8192,
    ramMib: 300,
    cpu: { limit: 0.5, weight: 200 },
    diskUsage: { exclusiveBytes: 1203 * 1_048_576, isPartial: false, isUpperBound: true },
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
  });

  const rows = formatTop([idle, busy])
    .split('\n')
    .map((row) => row.split(/\s{2,}/));

  expect(rows).toStrictEqual([
    [
      'NAME',
      'STATE',
      'CPU',
      'WEIGHT',
      'THROTTLED',
      'RAM',
      'DISK',
      'NET IN',
      'NET OUT',
      'WAKES',
      'AWAKE',
    ],
    [
      'busy',
      'running',
      '50% / 0.5',
      '200',
      '4s',
      '300 MiB',
      '<=1203 MiB / 8 GiB',
      '2.0 KiB',
      '10 B',
      '0',
      '2h',
    ],
    ['idle', 'running', '2%', '100', '0s', '300 MiB', '- / 8 GiB', '2.0 KiB', '10 B', '3', '90s'],
  ]);
});

test('#readCpuArgs reads a limit of none and a weight', () => {
  expect(readCpuArgs({ 'cpu-limit': 'none', 'cpu-weight': '50' })).toStrictEqual({
    cpuLimit: null,
    cpuWeight: 50,
  });
});

test('#readCpuArgs reads no CPU flags as no change', () => {
  expect(readCpuArgs({})).toStrictEqual({});
});

test('#setCommand refuses a set with no change before any call', async () => {
  // a call that slipped through would fail on the dead address instead
  const result = await runCli({ args: ['set', 'box'], env: { IMP_URL: 'http://127.0.0.1:1' } });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'imp: imp set needs --cpu-limit, --cpu-weight, --cpus or --http-port\n',
    code: 2,
  });
});
