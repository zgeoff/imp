import { expect, test } from 'bun:test';
import { pickSleepVictims } from './pick-sleep-victims';

test('it picks the least recently active imp when it frees enough', () => {
  const picked = pickSleepVictims(
    [
      { id: 'new', ramMib: 500, lastActiveAt: 300, held: false, busy: false },
      { id: 'old', ramMib: 400, lastActiveAt: 100, held: false, busy: false },
      { id: 'mid', ramMib: 400, lastActiveAt: 200, held: false, busy: false },
    ],
    300,
  );

  expect(picked.victims.map((victim) => victim.id)).toStrictEqual(['old']);
  expect(picked.enough).toBeTrue();
});

test('it picks the least recently active imps in order until enough RAM is free', () => {
  const picked = pickSleepVictims(
    [
      { id: 'new', ramMib: 500, lastActiveAt: 300, held: false, busy: false },
      { id: 'old', ramMib: 400, lastActiveAt: 100, held: false, busy: false },
      { id: 'mid', ramMib: 400, lastActiveAt: 200, held: false, busy: false },
    ],
    700,
  );

  expect(picked.victims.map((victim) => victim.id)).toStrictEqual(['old', 'mid']);
  expect(picked.enough).toBeTrue();
});

test('it never picks a held or a busy imp', () => {
  const picked = pickSleepVictims(
    [
      { id: 'held', ramMib: 400, lastActiveAt: 100, held: true, busy: false },
      { id: 'busy', ramMib: 400, lastActiveAt: 150, held: false, busy: true },
      { id: 'free', ramMib: 400, lastActiveAt: 200, held: false, busy: false },
    ],
    300,
  );

  expect(picked.victims.map((victim) => victim.id)).toStrictEqual(['free']);
  expect(picked.enough).toBeTrue();
});

test('it counts RAM that frees exactly what is needed as enough', () => {
  const picked = pickSleepVictims(
    [
      { id: 'a', ramMib: 300, lastActiveAt: 1, held: false, busy: false },
      { id: 'b', ramMib: 200, lastActiveAt: 2, held: false, busy: false },
    ],
    500,
  );

  expect(picked.victims.map((victim) => victim.id)).toStrictEqual(['a', 'b']);
  expect(picked.enough).toBeTrue();
});

test('it lists every eligible imp, oldest first, when together they are not enough', () => {
  const picked = pickSleepVictims(
    [
      { id: 'new', ramMib: 100, lastActiveAt: 3, held: false, busy: false },
      { id: 'held', ramMib: 900, lastActiveAt: 1, held: true, busy: false },
      { id: 'old', ramMib: 100, lastActiveAt: 2, held: false, busy: false },
    ],
    500,
  );

  expect(picked.victims.map((victim) => victim.id)).toStrictEqual(['old', 'new']);
  expect(picked.enough).toBeFalse();
});

test.each([
  ['nothing', 0],
  ['less than nothing', -50],
])('it picks no victim when %s is missing', (_label, needMib) => {
  expect(
    pickSleepVictims(
      [{ id: 'a', ramMib: 100, lastActiveAt: 1, held: false, busy: false }],
      needMib,
    ),
  ).toStrictEqual({ victims: [], enough: true });
});
