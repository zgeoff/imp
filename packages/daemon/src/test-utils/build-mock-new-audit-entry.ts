import { faker } from '@faker-js/faker';
import type { NewAuditEntry } from '../db/broker-audit';

// A forwarded request as the broker writes it to its audit log: a GET that
// got a 200, for an arbitrary imp, secret, host and path, at an arbitrary
// recent time.
export function buildMockNewAuditEntry(overrides: Partial<NewAuditEntry> = {}): NewAuditEntry {
  return {
    impId: faker.string.uuid(),
    secretName: faker.word.noun(),
    at: faker.date.recent(),
    method: 'GET',
    host: faker.internet.domainName(),
    path: `/${faker.word.noun()}`,
    status: 200,
    requestBytes: faker.number.int({ min: 0, max: 1024 ** 2 }),
    responseBytes: faker.number.int({ min: 0, max: 1024 ** 2 }),
    durationMs: faker.number.int({ min: 0, max: 60_000 }),
    ...overrides,
  };
}
