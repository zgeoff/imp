import { faker } from '@faker-js/faker';
import type { Session } from '../session-schema';

// A running session that no client is attached to, from an agent that counts
// output. It has no exit until a test gives it one.
export function buildMockSession(overrides: Partial<Session> = {}): Session {
  const startedAt = faker.date.past();

  return {
    name: faker.helpers.fromRegExp(/[a-z0-9][a-z0-9-]{2,12}/),
    pid: faker.number.int({ min: 2, max: 4_194_304 }),
    argv: [faker.system.fileName()],
    state: 'running',
    attached: false,
    cols: faker.number.int({ min: 20, max: 300 }),
    rows: faker.number.int({ min: 10, max: 120 }),
    startedAt,
    continuity: 'offsets',
    executionGeneration: faker.string.hexadecimal({ length: 32, casing: 'lower', prefix: '' }),
    bootId: faker.string.uuid(),
    end: faker.number.int({ min: 0, max: 2 ** 32 }),
    endObservedAt: faker.date.between({ from: startedAt, to: faker.defaultRefDate() }),
    log: false,
    ...overrides,
  };
}
