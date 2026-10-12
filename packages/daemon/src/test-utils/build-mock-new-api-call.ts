import { faker } from '@faker-js/faker';
import type { NewApiCall } from '../db/api-audit';

// An API call as writeApiCall takes it: a token's call that named an
// arbitrary imp and went through, with no detail, at an arbitrary recent time.
export function buildMockNewApiCall(overrides: Partial<NewApiCall> = {}): NewApiCall {
  return {
    at: faker.date.recent(),
    procedure: `imps.${faker.word.verb()}`,
    actor: 'token',
    actorName: faker.word.noun(),
    impName: faker.string.alphanumeric({ length: 8, casing: 'lower' }),
    outcome: 'ok',
    durationMs: faker.number.int({ min: 0, max: 60_000 }),
    detail: null,
    ...overrides,
  };
}
