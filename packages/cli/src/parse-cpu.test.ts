import { expect, test } from 'bun:test';
import { parseCpuLimit, parseCpuWeight } from './parse-cpu';
import { UsageError } from './usage-error';

test.each([
  ['1.5', 1.5],
  ['.5', 0.5],
  ['0.1', 0.1],
])('#parseCpuLimit reads %p as %p cores', (text, cores) => {
  expect(parseCpuLimit(text)).toBe(cores);
});

test('#parseCpuLimit reads none as no limit', () => {
  expect(parseCpuLimit('none')).toBeNull();
});

test.each(['0.05', 'two', '-1', ''])('#parseCpuLimit rejects %p as a usage error', (text) => {
  expect(() => parseCpuLimit(text)).toThrowWithMessage(
    UsageError,
    `--cpu-limit takes cores, at least 0.1 (such as 1.5), or none, not ${text}`,
  );
});

test.each([
  ['1', 1],
  ['200', 200],
  ['10000', 10_000],
])('#parseCpuWeight reads %p as the weight %p', (text, weight) => {
  expect(parseCpuWeight(text)).toBe(weight);
});

test.each(['0', '1.5', '10001', 'heavy'])('#parseCpuWeight rejects %p as a usage error', (text) => {
  expect(() => parseCpuWeight(text)).toThrowWithMessage(
    UsageError,
    `--cpu-weight takes a whole number from 1 to 10000, not ${text}`,
  );
});
