import { expect, test } from 'bun:test';
import { EVENT_VERSION, ImpEventSchema } from '@imp/api';
import { buildMockGovernorDecision } from './build-mock-governor-decision';

test('it builds a default governor decision', () => {
  const event = buildMockGovernorDecision();

  expect(event).toStrictEqual({
    v: EVENT_VERSION,
    at: expect.toBeValidDate(),
    ev: 'GovernorDecision',
    decision: 'admitted',
    name: expect.toSatisfy((value: string) => /^[a-z]{8}$/.test(value)),
    trigger: 'admission',
    usedMib: expect.toBeNumber(),
    budgetMib: expect.toBeNumber(),
  });

  expect(ImpEventSchema.safeParse(event).success).toBe(true);
});

test('it applies overrides on top of the defaults', () => {
  const event = buildMockGovernorDecision({
    at: new Date('2026-10-02T12:00:00Z'),
    decision: 'refused',
    name: 'dev',
    trigger: 'wake',
    usedMib: 900,
    budgetMib: 1024,
    neededMib: 256,
  });

  expect(event).toStrictEqual({
    v: EVENT_VERSION,
    at: new Date('2026-10-02T12:00:00Z'),
    ev: 'GovernorDecision',
    decision: 'refused',
    name: 'dev',
    trigger: 'wake',
    usedMib: 900,
    budgetMib: 1024,
    neededMib: 256,
  });
});
