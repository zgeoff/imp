import { expect, test } from 'bun:test';
import { ImpEventSchema } from '../event-schema';
import { buildMockGovernorDecision } from './build-mock-governor-decision';

test('it builds a default governor decision', () => {
  const decision = buildMockGovernorDecision();
  const received: unknown = decision;

  expect(received).toStrictEqual({
    v: 1,
    at: expect.toBeValidDate() as unknown,
    ev: 'GovernorDecision',
    decision: 'admitted',
    name: expect.stringMatching(/^[a-z][a-z0-9-]{2,12}$/) as unknown,
    trigger: 'admission',
    usedMib: expect.toBeWithin(0, decision.budgetMib + 1) as unknown,
    budgetMib: expect.toBeWithin(1024, 65_537) as unknown,
  });

  expect(ImpEventSchema.parse(decision)).toStrictEqual(decision);
});

test('it applies overrides on top of the defaults', () => {
  const decision: unknown = buildMockGovernorDecision({ name: 'dev', decision: 'refused' });

  expect(decision).toStrictEqual({
    v: 1,
    at: expect.toBeValidDate() as unknown,
    ev: 'GovernorDecision',
    decision: 'refused',
    name: 'dev',
    trigger: 'admission',
    usedMib: expect.any(Number) as unknown,
    budgetMib: expect.any(Number) as unknown,
  });
});
