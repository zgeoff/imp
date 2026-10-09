import { expect, test } from 'bun:test';
import { buildMockMoveTicketRow } from './build-mock-move-ticket-row';

test('it builds a default move ticket row', () => {
  expect(buildMockMoveTicketRow()).toStrictEqual({
    id: expect.toBeString(),
    secret_sha256: expect.toSatisfy((hash: string) => /^[0-9a-f]{64}$/v.test(hash)),
    name: expect.toSatisfy((name: string) => /^[a-z0-9]{12}$/v.test(name)),
    bytes: expect.toBeWithin(1, 64 * 1024 ** 3 + 1),
    imp_id: null,
    issued_at: expect.toBeNumber(),
    stream_by: expect.toBeNumber(),
    stream_used_at: null,
    receipt: null,
    commit_until: null,
    committed_at: null,
    slot: null,
  });
});

test('it applies overrides on top of the defaults', () => {
  const row = buildMockMoveTicketRow({
    id: 'ticket',
    secret_sha256: 'sha',
    name: 'moved',
    bytes: 1,
    imp_id: 'imp-1',
    issued_at: 0,
    stream_by: 60_000,
    stream_used_at: 10,
    receipt: '{}',
    commit_until: 120_000,
    committed_at: 90_000,
    slot: 2,
  });

  expect(row).toStrictEqual({
    id: 'ticket',
    secret_sha256: 'sha',
    name: 'moved',
    bytes: 1,
    imp_id: 'imp-1',
    issued_at: 0,
    stream_by: 60_000,
    stream_used_at: 10,
    receipt: '{}',
    commit_until: 120_000,
    committed_at: 90_000,
    slot: 2,
  });
});

test('it opens the stream window after the issue', () => {
  const row = buildMockMoveTicketRow();

  expect(row.stream_by).toBeGreaterThan(row.issued_at);
});
