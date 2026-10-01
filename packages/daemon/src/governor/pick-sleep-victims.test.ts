import { expect, test } from 'bun:test';
import { pickSleepVictims } from './pick-sleep-victims';
import type { VictimCandidate } from './pick-sleep-victims';

function buildCandidate(id: string, ramMib: number, lastActiveAt: number): VictimCandidate {
  return { id, ramMib, lastActiveAt, held: false, busy: false };
}

test('it picks the least recently active imps until enough RAM is free', () => {
  const candidates = [
    buildCandidate('new', 500, 300),
    buildCandidate('old', 400, 100),
    buildCandidate('mid', 400, 200),
  ];

  expect(pickSleepVictims(candidates, 300)).toEqual(['old']);
  expect(pickSleepVictims(candidates, 700)).toEqual(['old', 'mid']);
});

test('it skips held and busy imps', () => {
  const candidates = [
    { ...buildCandidate('held', 400, 100), held: true },
    { ...buildCandidate('busy', 400, 150), busy: true },
    buildCandidate('free', 400, 200),
  ];

  expect(pickSleepVictims(candidates, 300)).toEqual(['free']);
});

test('it gives up when every eligible imp together is not enough', () => {
  const candidates = [buildCandidate('a', 100, 1), { ...buildCandidate('b', 900, 2), held: true }];

  expect(pickSleepVictims(candidates, 500)).toBeNull();
});

test('it needs no victim when nothing is missing', () => {
  expect(pickSleepVictims([buildCandidate('a', 100, 1)], 0)).toEqual([]);
});
