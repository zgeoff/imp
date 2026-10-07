import { faker } from '@faker-js/faker';
import { EVENT_VERSION } from '../event-schema';
import type { ImpEvent } from '../event-schema';

type GovernorDecision = Extract<ImpEvent, { ev: 'GovernorDecision' }>;

// The RAM governor's event on impd's stream: an admitted boot of an imp,
// within the budget.
export function buildMockGovernorDecision(
  overrides: Partial<GovernorDecision> = {},
): GovernorDecision {
  const budgetMib = faker.number.int({ min: 1024, max: 65_536 });

  return {
    v: EVENT_VERSION,
    at: faker.date.past(),
    ev: 'GovernorDecision',
    decision: 'admitted',
    name: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/),
    trigger: 'admission',
    usedMib: faker.number.int({ min: 0, max: budgetMib }),
    budgetMib,
    ...overrides,
  };
}
