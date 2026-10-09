import { faker } from '@faker-js/faker';
import type { BrokerRule } from '../secret-schema';

// A bearer rule for an arbitrary host, with no user and no upstream
export function buildMockBrokerRule(overrides: Partial<BrokerRule> = {}): BrokerRule {
  return {
    host: faker.internet.domainName().toLowerCase(),
    header: 'authorization',
    scheme: 'bearer',
    ...overrides,
  };
}
