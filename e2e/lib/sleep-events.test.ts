import { expect, test } from 'bun:test';
import { parseSleepSpan } from './sleep-events';

test('it reads a slept event as a sleep from its time less its duration and its prepare', () => {
  const line = JSON.stringify({
    v: 1,
    at: '2026-10-03T00:02:54.584Z',
    ev: 'ImpChanged',
    reason: 'slept',
    imp: { name: 'e2e-scale-02' },
    detail: { trigger: 'to make room for e2e-scale-12', durationMs: 1145, prepareMs: 300 },
  });

  expect(parseSleepSpan(line)).toStrictEqual({
    startAt: Date.parse('2026-10-03T00:02:53.139Z'),
    endAt: Date.parse('2026-10-03T00:02:54.584Z'),
    isEnforce: false,
  });
});

test('it counts prepareMs as 0 for a slept event from an impd without it', () => {
  const line = JSON.stringify({
    v: 1,
    at: '2026-10-03T00:02:54.584Z',
    ev: 'ImpChanged',
    reason: 'slept',
    detail: { durationMs: 1145 },
  });

  expect(parseSleepSpan(line)?.startAt).toBe(Date.parse('2026-10-03T00:02:53.439Z'));
});

test('it marks a sleep by the enforce pass', () => {
  const line = JSON.stringify({
    v: 1,
    at: '2026-10-03T00:02:54.584Z',
    ev: 'ImpChanged',
    reason: 'slept',
    detail: { trigger: 'RAM over budget', durationMs: 900 },
  });

  expect(parseSleepSpan(line)?.isEnforce).toBeTrue();
});

test.each([
  ['a woke event', '{"v":1,"at":"2026-10-03T00:02:54.584Z","ev":"ImpChanged","reason":"woke"}'],
  ['a governor decision', '{"v":1,"at":"2026-10-03T00:02:54.584Z","ev":"GovernorDecision"}'],
])('it reads %s as no sleep', (_label, line) => {
  expect(parseSleepSpan(line)).toBeNull();
});
