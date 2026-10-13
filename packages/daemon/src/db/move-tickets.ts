import type { Insertable, Selectable, Updateable } from 'kysely';
import { isSlotFree } from './imps';
import type { ImpDatabase, ImpQueries } from './open-database';
import type { DB } from './schema';

// The target's side of a move: one receive ticket, kept by the sha256 of its
// secret (docs/architecture/storage/moves.md#the-steps)
export type MoveTicketRow = Selectable<DB['move_tickets']>;

export type NewMoveTicketRow = Insertable<DB['move_tickets']>;

export function findMoveTicket(db: ImpQueries, id: string): Promise<MoveTicketRow | undefined> {
  return db.selectFrom('move_tickets').selectAll().where('id', '=', id).executeTakeFirst();
}

// the ticket of an imp staged here that waits for its commit
export function findStagedMoveTicket(
  db: ImpQueries,
  impId: string,
): Promise<MoveTicketRow | undefined> {
  return db
    .selectFrom('move_tickets')
    .selectAll()
    .where('imp_id', '=', impId)
    .where('receipt', 'is not', null)
    .executeTakeFirst();
}

export function listMoveTickets(db: ImpQueries): Promise<MoveTicketRow[]> {
  return db.selectFrom('move_tickets').selectAll().execute();
}

export async function writeMoveTicket(db: ImpQueries, row: NewMoveTicketRow): Promise<void> {
  await db.insertInto('move_tickets').values(row).execute();
}

// A warm move's ticket, which keeps `row.slot` for the imp it brings: the
// check and the insert share one transaction, so two tickets never keep the
// same slot. False when an imp or another ticket holds the slot.
export function createMoveTicketInFreeSlot(
  db: ImpDatabase,
  row: NewMoveTicketRow & { readonly slot: number },
  now: number,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    if (!(await isSlotFree(trx, row.slot, now))) {
      return false;
    }

    await writeMoveTicket(trx, row);

    return true;
  });
}

export async function updateMoveTicket(
  db: ImpQueries,
  id: string,
  fields: Updateable<DB['move_tickets']>,
): Promise<void> {
  await db.updateTable('move_tickets').set(fields).where('id', '=', id).execute();
}

// Marks the ticket's stream started, once: false when a stream used it
// already
export async function claimMoveTicketStream(
  db: ImpQueries,
  id: string,
  at: number,
): Promise<boolean> {
  const marked = await db
    .updateTable('move_tickets')
    .set({ stream_used_at: at })
    .where('id', '=', id)
    .where('stream_used_at', 'is', null)
    .executeTakeFirst();

  return marked.numUpdatedRows > 0n;
}

// the ticket, and with an imp every other ticket for that imp
export async function removeMoveTickets(
  db: ImpQueries,
  id: string,
  impId: string | null,
): Promise<void> {
  await db
    .deleteFrom('move_tickets')
    .where((eb) =>
      eb.or([eb('id', '=', id), ...(impId === null ? [] : [eb('imp_id', '=', impId)])]),
    )
    .execute();
}
