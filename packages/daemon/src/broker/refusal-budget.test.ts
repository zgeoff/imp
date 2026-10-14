import { expect, test } from 'bun:test';
import { createRefusalBudget } from './refusal-budget';

test('it counts an imp’s entries up to the budget, and refuses the next in the same second', () => {
  const budget = createRefusalBudget({ perSecond: 2, now: () => 5000 });
  const claims = [budget.tryClaim('imp-1'), budget.tryClaim('imp-1'), budget.tryClaim('imp-1')];

  expect(claims).toStrictEqual([true, true, false]);
});

test('it keeps a budget of its own for each imp', () => {
  const budget = createRefusalBudget({ perSecond: 1, now: () => 5000 });

  budget.tryClaim('imp-1');

  expect(budget.tryClaim('imp-2')).toBeTrue();
});

test('it gives an imp its whole budget again once the next second starts', () => {
  const clock = { ms: 5999 };
  const budget = createRefusalBudget({ perSecond: 1, now: () => clock.ms });

  budget.tryClaim('imp-1');

  clock.ms = 6000;

  expect(budget.tryClaim('imp-1')).toBeTrue();
});
