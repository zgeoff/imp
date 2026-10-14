import { faker } from '@faker-js/faker';
import type { AuditEntry } from '../schemas/secret-schema';

// A GET the broker sent with a credential and that got a 200, for an
// arbitrary imp, secret, host and path. The date counts back from faker's
// reference date, which the preload fixes.
export function buildMockAuditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    at: faker.date.past(),
    imp: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/),
    secret: faker.helpers.fromRegExp(/[a-z][a-z0-9-]{2,12}/),
    method: 'GET',
    host: faker.internet.domainName().toLowerCase(),
    path: `/${faker.word.noun()}`,
    status: 200,
    requestBytes: faker.number.int({ min: 0, max: 1024 ** 2 }),
    responseBytes: faker.number.int({ min: 0, max: 1024 ** 2 }),
    durationMs: faker.number.int({ min: 0, max: 60_000 }),
    reason: null,
    ...overrides,
  };
}
