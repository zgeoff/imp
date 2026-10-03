import { expect, test } from 'bun:test';
import { parseSleepSpan } from './sleep-events';

test('a slept event is a sleep from its time less its duration', () => {
  const line = JSON.stringify({
    v: 1,
    at: '2026-10-03T00:02:54.584Z',
    ev: 'ImpChanged',
    reason: 'slept',
    imp: { name: 'e2e-scale-02' },
    detail: { trigger: 'to make room for e2e-scale-12', durationMs: 1145 },
  });

  const endAt = Date.parse('2026-10-03T00:02:54.584Z');

  expect(parseSleepSpan(line)).toEqual({ startAt: endAt - 1145, endAt });
});

test('every other event is no sleep', () => {
  const woke = { v: 1, at: '2026-10-03T00:02:54.584Z', ev: 'ImpChanged', reason: 'woke' };
  const decision = { v: 1, at: '2026-10-03T00:02:54.584Z', ev: 'GovernorDecision' };

  expect(parseSleepSpan(JSON.stringify(woke))).toBeNull();
  expect(parseSleepSpan(JSON.stringify(decision))).toBeNull();
});
