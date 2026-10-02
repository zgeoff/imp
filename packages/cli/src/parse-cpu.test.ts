import { expect, test } from 'bun:test';
import { parseCpuLimit, parseCpuWeight } from './parse-cpu';

test('a CPU limit is cores from 0.1, or none', () => {
  expect(parseCpuLimit('1.5')).toBe(1.5);
  expect(parseCpuLimit('.5')).toBe(0.5);
  expect(parseCpuLimit('none')).toBeNull();
  expect(() => parseCpuLimit('0.05')).toThrow('at least 0.1');
  expect(() => parseCpuLimit('two')).toThrow('--cpu-limit takes cores');
});

test('a CPU weight is a whole number from 1 to 10000', () => {
  expect(parseCpuWeight('200')).toBe(200);
  expect(() => parseCpuWeight('0')).toThrow('from 1 to 10000');
  expect(() => parseCpuWeight('1.5')).toThrow('from 1 to 10000');
});
