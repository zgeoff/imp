import { faker } from '@faker-js/faker';
import type { Insertable } from 'kysely';
import type { DB } from '../db/schema';

type MoveSendRow = Insertable<DB['move_sends']>;

// A move_sends row as a prepare writes one: a cold move of files with no
// target, ticket, receipt or error yet; its imp, size and age arbitrary.
export function buildMockMoveSendRow(overrides: Partial<MoveSendRow> = {}): MoveSendRow {
  return {
    imp_id: faker.string.uuid(),
    peer_url: null,
    ticket: null,
    total_bytes: faker.number.int({ min: 1, max: 64 * 1024 ** 3 }),
    mode: 'files',
    warm: 0,
    receipt: null,
    error: null,
    created_at: faker.date.recent().getTime(),
    ...overrides,
  };
}
