import { expect, test } from 'bun:test';
import { readCpuArgs } from './cpu-args';

test('it reads a limit of none and a weight', () => {
  expect(readCpuArgs({ 'cpu-limit': 'none', 'cpu-weight': '50' })).toStrictEqual({
    cpuLimit: null,
    cpuWeight: 50,
  });
});

test('it reads no CPU flags as no change', () => {
  expect(readCpuArgs({})).toStrictEqual({});
});
