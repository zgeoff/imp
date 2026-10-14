import { expect, test } from 'bun:test';
import { findU32Span, parseLoggedSteps, pickPercentile } from './boot-template-timing';

test('#findU32Span measures the distance between two values', () => {
  expect(findU32Span(1000, 250)).toBe(750);
});

test('#findU32Span measures around the wrap', () => {
  expect(findU32Span(2 ** 32 - 10, 5)).toBe(15);
});

test('#parseLoggedSteps reads the steps of the last line that names the imp', () => {
  const log = [
    'impd: e2e-bt-t0: restored boot template 0123456789ab as pid 7 load=1ms agent=2ms',
    'impd: e2e-bt-t1: restored boot template 0123456789ab as pid 9 load=12ms agent=30ms',
    'impd: e2e-bt-t1: restored boot template 0123456789ab as pid 11 load=14ms agent=31ms',
  ].join('\n');

  expect(parseLoggedSteps(log, 'e2e-bt-t1', 'restored boot template')).toStrictEqual({
    load: 14,
    agent: 31,
  });
});

test('#parseLoggedSteps adds the total of a created line', () => {
  const log = 'impd: e2e-bt-t0: created in 48ms (disk=5ms boot=40ms)\n';

  expect(parseLoggedSteps(log, 'e2e-bt-t0', 'created in')).toStrictEqual({
    disk: 5,
    boot: 40,
    total: 48,
  });
});

test('#parseLoggedSteps reads a log without the imp as no steps', () => {
  expect(
    parseLoggedSteps('impd: e2e-bt-t0: created in 48ms\n', 'e2e-bt-t1', 'created in'),
  ).toStrictEqual({});
});

test('#pickPercentile picks the nearest-rank value', () => {
  expect(pickPercentile([50, 10, 40, 20, 30], 0.5)).toBe(30);
});

test('#pickPercentile picks the largest value for the 95th of a few', () => {
  expect(pickPercentile([5, 1, 9], 0.95)).toBe(9);
});

test('#pickPercentile reads no values as 0', () => {
  expect(pickPercentile([], 0.5)).toBe(0);
});
