import { expect, test } from 'bun:test';
import { buildMockMoveTicketRow } from '../test-utils/build-mock-move-ticket-row';
import { createTestDatabase } from '../test-utils/create-test-database';
import {
  claimMoveTicketStream,
  createMoveTicketInFreeSlot,
  findMoveTicket,
  findStagedMoveTicket,
  listMoveTickets,
  removeMoveTickets,
  updateMoveTicket,
  writeMoveTicket,
} from './move-tickets';

async function setupTest() {
  const database = await createTestDatabase();

  return { db: database.db };
}

test('#findMoveTicket reads the ticket it wrote', async () => {
  const ctx = await setupTest();

  const row = buildMockMoveTicketRow({ id: 'ticket-1' });

  await writeMoveTicket(ctx.db, row);

  const found = await findMoveTicket(ctx.db, 'ticket-1');

  expect(found).toStrictEqual(row);
});

test('#findMoveTicket finds nothing for an unknown ticket', async () => {
  const ctx = await setupTest();

  await writeMoveTicket(ctx.db, buildMockMoveTicketRow({ id: 'ticket-1' }));

  const found = await findMoveTicket(ctx.db, 'ticket-2');

  expect(found).toBeUndefined();
});

test('#findStagedMoveTicket finds the imp’s ticket that holds a receipt', async () => {
  const ctx = await setupTest();

  const staged = buildMockMoveTicketRow({ id: 'staged', imp_id: 'imp-1', receipt: '{}' });

  await writeMoveTicket(ctx.db, buildMockMoveTicketRow({ id: 'streaming', imp_id: 'imp-1' }));
  await writeMoveTicket(ctx.db, staged);

  const found = await findStagedMoveTicket(ctx.db, 'imp-1');

  expect(found).toStrictEqual(staged);
});

test('#findStagedMoveTicket finds nothing while the imp’s ticket has no receipt', async () => {
  const ctx = await setupTest();

  await writeMoveTicket(ctx.db, buildMockMoveTicketRow({ imp_id: 'imp-1' }));

  const found = await findStagedMoveTicket(ctx.db, 'imp-1');

  expect(found).toBeUndefined();
});

test('#listMoveTickets lists every ticket', async () => {
  const ctx = await setupTest();

  const first = buildMockMoveTicketRow();
  const second = buildMockMoveTicketRow();

  await writeMoveTicket(ctx.db, first);
  await writeMoveTicket(ctx.db, second);

  const rows = await listMoveTickets(ctx.db);

  expect(rows).toIncludeSameMembers([first, second]);
});

test('#createMoveTicketInFreeSlot writes a ticket that keeps a free slot', async () => {
  const ctx = await setupTest();

  const row = buildMockMoveTicketRow({ id: 'warm', slot: 3 });

  const isKept = await createMoveTicketInFreeSlot(ctx.db, { ...row, slot: 3 }, row.issued_at);
  const found = await findMoveTicket(ctx.db, 'warm');

  expect(isKept).toBe(true);
  expect(found).toStrictEqual(row);
});

test('#createMoveTicketInFreeSlot refuses a slot a live ticket keeps, writing nothing', async () => {
  const ctx = await setupTest();

  await writeMoveTicket(
    ctx.db,
    buildMockMoveTicketRow({ id: 'first', slot: 3, issued_at: 0, stream_by: 60_000 }),
  );

  const isKept = await createMoveTicketInFreeSlot(
    ctx.db,
    { ...buildMockMoveTicketRow({ id: 'second', issued_at: 1000 }), slot: 3 },
    1000,
  );

  const found = await findMoveTicket(ctx.db, 'second');

  expect(isKept).toBe(false);
  expect(found).toBeUndefined();
});

test('#updateMoveTicket sets the fields it is given', async () => {
  const ctx = await setupTest();

  await writeMoveTicket(ctx.db, buildMockMoveTicketRow({ id: 'ticket-1', slot: 3 }));
  await updateMoveTicket(ctx.db, 'ticket-1', { receipt: '{}', commit_until: 90_000, slot: null });

  const found = await findMoveTicket(ctx.db, 'ticket-1');

  expect(found).toMatchObject({ receipt: '{}', commit_until: 90_000, slot: null });
});

test('#claimMoveTicketStream marks an unused ticket’s stream started', async () => {
  const ctx = await setupTest();

  await writeMoveTicket(ctx.db, buildMockMoveTicketRow({ id: 'ticket-1' }));

  const isClaimed = await claimMoveTicketStream(ctx.db, 'ticket-1', 5000);
  const found = await findMoveTicket(ctx.db, 'ticket-1');

  expect(isClaimed).toBe(true);
  expect(found?.stream_used_at).toBe(5000);
});

test('#claimMoveTicketStream refuses a ticket a stream used already', async () => {
  const ctx = await setupTest();

  await writeMoveTicket(ctx.db, buildMockMoveTicketRow({ id: 'ticket-1', stream_used_at: 5000 }));

  const isClaimed = await claimMoveTicketStream(ctx.db, 'ticket-1', 6000);
  const found = await findMoveTicket(ctx.db, 'ticket-1');

  expect(isClaimed).toBe(false);
  expect(found?.stream_used_at).toBe(5000);
});

test('#removeMoveTickets removes the ticket and every other ticket of its imp', async () => {
  const ctx = await setupTest();

  const other = buildMockMoveTicketRow({ id: 'other', imp_id: 'imp-2' });

  await writeMoveTicket(ctx.db, buildMockMoveTicketRow({ id: 'first', imp_id: 'imp-1' }));
  await writeMoveTicket(ctx.db, buildMockMoveTicketRow({ id: 'reissued', imp_id: 'imp-1' }));
  await writeMoveTicket(ctx.db, other);
  await removeMoveTickets(ctx.db, 'first', 'imp-1');

  const rows = await listMoveTickets(ctx.db);

  expect(rows).toStrictEqual([other]);
});

test('#removeMoveTickets removes only the ticket when it names no imp', async () => {
  const ctx = await setupTest();

  const other = buildMockMoveTicketRow({ id: 'other' });

  await writeMoveTicket(ctx.db, buildMockMoveTicketRow({ id: 'first' }));
  await writeMoveTicket(ctx.db, other);
  await removeMoveTickets(ctx.db, 'first', null);

  const rows = await listMoveTickets(ctx.db);

  expect(rows).toStrictEqual([other]);
});
