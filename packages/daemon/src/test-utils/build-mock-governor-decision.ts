import { faker } from '@faker-js/faker';
import { EVENT_VERSION } from '@imp/api';
import type { ImpEvent } from '@imp/api';

type GovernorDecision = Extract<ImpEvent, { ev: 'GovernorDecision' }>;

// A GovernorDecision event as the RAM governor publishes one: an admitted
// boot of an imp whose name, time and RAM numbers are arbitrary.
export function buildMockGovernorDecision(
  overrides: Partial<GovernorDecision> = {},
): GovernorDecision {
  return {
    v: EVENT_VERSION,
    at: faker.date.recent(),
    ev: 'GovernorDecision',
    decision: 'admitted',
    name: faker.string.alpha({ length: 8, casing: 'lower' }),
    trigger: 'admission',
    usedMib: faker.number.int({ min: 0, max: 4096 }),
    budgetMib: faker.number.int({ min: 4097, max: 65_536 }),
    ...overrides,
  };
}
