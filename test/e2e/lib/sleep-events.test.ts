import { expect, test } from 'bun:test';
import { parseSleepSpan } from './sleep-events';

test('a slept event is a sleep from its time less its duration and its prepare', () => {
  const line = JSON.stringify({
    v: 1,
    at: '2026-10-03T00:02:54.584Z',
    ev: 'ImpChanged',
    reason: 'slept',
    imp: { name: 'e2e-scale-02' },
    detail: { trigger: 'to make room for e2e-scale-12', durationMs: 1145, prepareMs: 300 },
  });

  const endAt = Date.parse('2026-10-03T00:02:54.584Z');

  expect(parseSleepSpan(line)).toEqual({ startAt: endAt - 1445, endAt, isEnforce: false });
});

test('a slept event from an impd without prepareMs counts it as 0', () => {
  const line = JSON.stringify({
    v: 1,
    at: '2026-10-03T00:02:54.584Z',
    ev: 'ImpChanged',
    reason: 'slept',
    detail: { durationMs: 1145 },
  });

  expect(parseSleepSpan(line)?.startAt).toBe(Date.parse('2026-10-03T00:02:54.584Z') - 1145);
});

test('a sleep by the enforce pass says so', () => {
  const line = JSON.stringify({
    v: 1,
    at: '2026-10-03T00:02:54.584Z',
    ev: 'ImpChanged',
    reason: 'slept',
    detail: { trigger: 'RAM over budget', durationMs: 900 },
  });

  expect(parseSleepSpan(line)?.isEnforce).toBe(true);
});

test('every other event is no sleep', () => {
  const woke = { v: 1, at: '2026-10-03T00:02:54.584Z', ev: 'ImpChanged', reason: 'woke' };
  const decision = { v: 1, at: '2026-10-03T00:02:54.584Z', ev: 'GovernorDecision' };

  expect(parseSleepSpan(JSON.stringify(woke))).toBeNull();
  expect(parseSleepSpan(JSON.stringify(decision))).toBeNull();
});
