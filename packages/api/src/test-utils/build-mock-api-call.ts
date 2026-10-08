import { faker } from '@faker-js/faker';
import type { ApiCall } from '../api-call-schema';

// A named token's call on an imp that succeeded, with no detail. The date
// counts back from faker's reference date, which the preload fixes.
export function buildMockApiCall(overrides: Partial<ApiCall> = {}): ApiCall {
  return {
    at: faker.date.past(),
    procedure: faker.helpers.arrayElement(['imps.stop', 'imps.start', 'imps.create']),
    actor: 'token',
    actorName: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/),
    imp: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/),
    outcome: 'ok',
    durationMs: faker.number.int({ min: 0, max: 10_000 }),
    ...overrides,
  };
}
