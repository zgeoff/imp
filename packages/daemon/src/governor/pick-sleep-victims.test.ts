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

  expect(pickSleepVictims(candidates, 300)).toEqual({ victims: ['old'], enough: true });
  expect(pickSleepVictims(candidates, 700)).toEqual({ victims: ['old', 'mid'], enough: true });
});

test('it skips held and busy imps', () => {
  const candidates = [
    { ...buildCandidate('held', 400, 100), held: true },
    { ...buildCandidate('busy', 400, 150), busy: true },
    buildCandidate('free', 400, 200),
  ];

  expect(pickSleepVictims(candidates, 300)).toEqual({ victims: ['free'], enough: true });
});

test('it frees exactly what is needed', () => {
  const candidates = [buildCandidate('a', 300, 1), buildCandidate('b', 200, 2)];

  expect(pickSleepVictims(candidates, 500)).toEqual({ victims: ['a', 'b'], enough: true });
});

test('it lists every eligible imp, oldest first, when together they are not enough', () => {
  const candidates = [
    buildCandidate('new', 100, 3),
    { ...buildCandidate('held', 900, 1), held: true },
    buildCandidate('old', 100, 2),
  ];

  expect(pickSleepVictims(candidates, 500)).toEqual({ victims: ['old', 'new'], enough: false });
});

test('it needs no victim when nothing is missing', () => {
  const candidates = [buildCandidate('a', 100, 1)];

  expect(pickSleepVictims(candidates, 0)).toEqual({ victims: [], enough: true });
  expect(pickSleepVictims(candidates, -50)).toEqual({ victims: [], enough: true });
});
