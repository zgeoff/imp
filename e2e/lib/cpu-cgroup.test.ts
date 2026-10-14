import { expect, test } from 'bun:test';
import { parseCpuStat } from './cpu-cgroup';

test('#parseCpuStat reads the usage and throttled time', () => {
  const text = [
    'usage_usec 2500000',
    'user_usec 2000000',
    'system_usec 500000',
    'nr_periods 50',
    'nr_throttled 40',
    'throttled_usec 1800000',
    '',
  ].join('\n');

  expect(parseCpuStat(text)).toStrictEqual({ usageUsec: 2_500_000, throttledUsec: 1_800_000 });
});

test('#parseCpuStat throws on a cpu.stat without the throttled time', () => {
  expect(() => parseCpuStat('usage_usec 10\n')).toThrowWithMessage(
    TypeError,
    String.raw`no throttled_usec in cpu.stat: "usage_usec 10\n"`,
  );
});
