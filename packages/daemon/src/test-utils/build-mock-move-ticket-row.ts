import { faker } from '@faker-js/faker';
import type { Insertable } from 'kysely';
import type { DatabaseSchema } from '../db/schema';

type MoveTicketRow = Insertable<DatabaseSchema['move_tickets']>;

// A move_tickets row as a target issues one: its stream not started, no
// receipt, no commit and no warm slot; its id, secret hash, name, size and
// times arbitrary.
export function buildMockMoveTicketRow(overrides: Partial<MoveTicketRow> = {}): MoveTicketRow {
  const issuedAt = faker.date.recent().getTime();

  return {
    id: faker.string.uuid(),
    secret_sha256: faker.string.hexadecimal({ length: 64, casing: 'lower', prefix: '' }),
    name: faker.string.alphanumeric({ length: 12, casing: 'lower' }),
    bytes: faker.number.int({ min: 1, max: 64 * 1024 ** 3 }),
    imp_id: null,
    issued_at: issuedAt,
    stream_by: issuedAt + faker.number.int({ min: 1000, max: 600_000 }),
    stream_used_at: null,
    receipt: null,
    commit_until: null,
    committed_at: null,
    slot: null,
    ...overrides,
  };
}
