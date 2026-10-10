import { expect, test } from 'bun:test';
import { checkAwakePastIdle } from './awake-past-idle';

test('#checkAwakePastIdle holds for a running imp found active a full idle timeout later', () => {
  const since = Date.parse('2026-10-10T04:00:00.000Z');

  expect(
    checkAwakePastIdle({ state: 'running', lastActiveAt: '2026-10-10T04:00:10.000Z' }, since, 10),
  ).toBeTrue();
});

test('#checkAwakePastIdle fails for a running imp last found active within the idle timeout', () => {
  const since = Date.parse('2026-10-10T04:00:00.000Z');

  expect(
    checkAwakePastIdle({ state: 'running', lastActiveAt: '2026-10-10T04:00:09.999Z' }, since, 10),
  ).toBeFalse();
});

test('#checkAwakePastIdle fails for an imp that slept, whenever it was last active', () => {
  const since = Date.parse('2026-10-10T04:00:00.000Z');

  expect(
    checkAwakePastIdle({ state: 'sleeping', lastActiveAt: '2026-10-10T04:00:30.000Z' }, since, 10),
  ).toBeFalse();
});
