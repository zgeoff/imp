import { faker } from '@faker-js/faker';
import type { RefusedRequest } from '../schemas/secret-schema';

// A CONNECT the broker refused under the imp's egress policy, for an
// arbitrary imp and host. The date counts back from faker's reference date,
// which the preload fixes.
export function buildMockRefusedRequest(overrides: Partial<RefusedRequest> = {}): RefusedRequest {
  return {
    at: faker.date.past(),
    imp: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/u),
    method: 'CONNECT',
    host: faker.internet.domainName().toLowerCase(),
    path: null,
    status: 403,
    durationMs: faker.number.int({ min: 0, max: 60_000 }),
    reason: 'egress-policy',
    ...overrides,
  };
}
