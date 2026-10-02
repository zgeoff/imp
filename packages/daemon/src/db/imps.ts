import { PublicAuthSchema } from '@imp/api';
import type {
  ColdBootCause,
  EgressPolicy,
  ImpChangeReason,
  ImpEventDetail,
  ImpState,
  MoveState,
  PublicAuth,
} from '@imp/api';
import { sql } from 'kysely';
import type { Selectable, Updateable } from 'kysely';
import { emitImpWrite } from './imp-write-feed';
import type { ImpDatabase } from './open-database';
import type { DatabaseSchema } from './schema';

type ImpRow = Selectable<DatabaseSchema['imps']>;

export interface ImpRecord {
  readonly id: string;
  readonly name: string;
  readonly imageId: string;
  readonly state: ImpState;
  readonly vcpus: number;
  readonly memoryMib: number;
  readonly slot: number;
  readonly ip: string;
  readonly createdAt: Date;
  readonly lastActiveAt: Date;
  readonly sleptAt: Date | null;
  readonly holdUntil: Date | null;
  readonly error: string | null;
  readonly pid: number | null;
  readonly firecrackerVersion: string | null;
  readonly httpPort: number;
  readonly diskBytes: number;
  readonly isDiskGrowPending: boolean;

  // what a public imp asks for; null while it is tailnet-only
  readonly publicAuth: PublicAuth | null;
  readonly cpu: CpuSettings;
  readonly wakeCount: number;

  // its jailed Firecracker's uid and gid (JAIL_UIDS); null only for a row
  // the migration could not number
  readonly jailUid: number | null;

  // awake time up to awakeSince; while the imp runs, add the time since
  readonly awakeMs: number;
  readonly awakeSince: Date | null;

  // an imp from a template, not yet booted with its own machine-id and ssh
  // host keys (docs/guides/templates.md#identity)
  readonly isIdentityResetPending: boolean;

  // a warm move's imp until its first wake here (docs/architecture/moves.md#warm-moves)
  readonly isTrustPending: boolean;

  // set while the imp moves between hosts (moves/)
  readonly moveState: MoveState | null;
}

// cores the VM may use (null: no limit) and its cgroup cpu.weight
export interface CpuSettings {
  readonly limit: number | null;
  readonly weight: number;
}

export interface NewImp {
  // a fresh UUIDv7 when left out
  readonly id?: string;
  readonly name: string;
  readonly imageId: string;
  readonly vcpus: number;
  readonly memoryMib: number;
  readonly slot: number;
  readonly ip: string;
  readonly httpPort?: number;

  // 32 GiB when left out
  readonly diskBytes?: number;

  // open when left out; written in the insert, so the imp never exists
  // without its policy
  readonly egress?: EgressPolicy;
  readonly cpu?: CpuSettings;
  readonly isIdentityResetPending?: boolean;

  // the networks it joins, in the insert's transaction: its first firewall
  // has them
  readonly networkIds?: readonly string[];

  // a move stages the imp marked
  readonly moveState?: MoveState;
}

export interface ImpStateChange {
  // why, for the event stream
  readonly reason: ImpChangeReason;
  readonly detail?: ImpEventDetail;
  readonly state: ImpState;
  readonly error?: string | null;
  readonly pid?: number | null;
  readonly sleptAt?: Date | null;
  readonly firecrackerVersion?: string | null;

  // a cold boot that stands in for a wake counts as one, as a `woke` does
  readonly countsWake?: boolean;

  // when a running imp's awake span ends; now by default. A repair passes
  // the last time anything saw the VM alive.
  readonly awakeUntil?: Date;

  // the cause the next cold boot records, whichever path boots it: a repair
  // knows it before that boot (docs/architecture/daemon.md#output-offsets)
  readonly nextBootCause?: Extract<ColdBootCause, 'recovery' | 'wake_fallback'>;
}

// The uids jailed Firecrackers run as, one per imp, gid the same: far above
// any account in the host image, and kept for the imp's life
export const JAIL_UIDS = { first: 900_000, count: 65_536 } as const;

// what every boot template build runs as, one at a time: below the imps'
export const TEMPLATE_BUILD_UID = JAIL_UIDS.first - 1;

// the lowest free uid of JAIL_UIDS; a destroyed imp's uid goes back
async function allocateJailUid(db: ImpDatabase): Promise<number> {
  const rows = await db
    .selectFrom('imps')
    .select('jail_uid')
    .where('jail_uid', 'is not', null)
    .orderBy('jail_uid')
    .execute();

  let uid = JAIL_UIDS.first;

  for (const row of rows) {
    if (row.jail_uid !== uid) {
      break;
    }

    uid += 1;
  }

  if (uid >= JAIL_UIDS.first + JAIL_UIDS.count) {
    throw new Error(`every one of the ${String(JAIL_UIDS.count)} jail uids is taken`);
  }

  return uid;
}

// The slots imps hold, and those that a warm move's live ticket keeps for
// the imp it brings (docs/architecture/moves.md#warm-moves): until the
// commit, once its stream started, else until the stream's start window ends
async function listTakenSlots(db: ImpDatabase, now: number): Promise<Set<number>> {
  const imps = await db.selectFrom('imps').select('slot').execute();

  const held = await db
    .selectFrom('move_tickets')
    .select('slot')
    .where('slot', 'is not', null)
    .where('committed_at', 'is', null)
    .where((row) => row.or([row('stream_used_at', 'is not', null), row('stream_by', '>', now)]))
    .execute();

  return new Set([...imps.map((row) => row.slot), ...held.flatMap((row) => row.slot ?? [])]);
}

// The lowest slot no imp or ticket holds. Run it in the same transaction as
// the insert that takes the slot; the unique index on `slot` backs that up.
export async function allocateSlot(
  db: ImpDatabase,
  slotCount: number,
  now: number = Date.now(),
): Promise<number> {
  const taken = await listTakenSlots(db, now);

  let slot = 0;

  while (taken.has(slot)) {
    slot += 1;
  }

  if (slot >= slotCount) {
    throw new Error(`every one of the ${String(slotCount)} slots is taken`);
  }

  return slot;
}

// whether a warm move may keep `slot`: no imp and no live ticket holds it
export async function isSlotFree(db: ImpDatabase, slot: number, now: number): Promise<boolean> {
  const taken = await listTakenSlots(db, now);

  return !taken.has(slot);
}

// A slot a warm move asks for, free of imps; its own ticket holds it
class SlotTakenError extends Error {
  override name = 'SlotTakenError';

  constructor(slot: number) {
    super(`slot ${String(slot)} is taken on this host`);
  }
}

export async function createImp(db: ImpDatabase, imp: NewImp): Promise<ImpRecord> {
  const created = await writeImpRow(db, imp);

  emitImpWrite(db, { kind: 'added', imp: created });

  return created;
}

// the insert alone; the caller emits once the row is committed
async function writeImpRow(db: ImpDatabase, imp: NewImp): Promise<ImpRecord> {
  const now = Date.now();

  const jailUid = await allocateJailUid(db);

  const row = await db
    .insertInto('imps')
    .values({
      id: imp.id ?? Bun.randomUUIDv7(),
      name: imp.name,
      image_id: imp.imageId,
      state: 'creating',
      vcpus: imp.vcpus,
      memory_mib: imp.memoryMib,
      slot: imp.slot,
      ip: imp.ip,
      ...(imp.httpPort !== undefined && { http_port: imp.httpPort }),
      ...(imp.diskBytes !== undefined && { disk_bytes: imp.diskBytes }),
      ...(imp.isIdentityResetPending === true && { identity_reset_pending: 1 }),
      ...(imp.egress !== undefined && {
        egress_policy: imp.egress.mode,
        egress_allow: JSON.stringify(imp.egress.allow),
      }),
      ...(imp.cpu !== undefined && { cpu_limit: imp.cpu.limit, cpu_weight: imp.cpu.weight }),
      ...(imp.moveState !== undefined && { move_state: imp.moveState }),
      created_at: now,
      last_active_at: now,
      jail_uid: jailUid,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  if (imp.networkIds !== undefined && imp.networkIds.length > 0) {
    await db
      .insertInto('network_members')
      .values(imp.networkIds.map((networkId) => ({ network_id: networkId, imp_id: row.id })))
      .execute();
  }

  return toImpRecord(row);
}

interface FreeSlots {
  readonly count: number;
  readonly findIp: (slot: number) => string;

  // a warm move's: this slot or none
  readonly slot?: number | undefined;

  // when a ticket's start window ends against
  readonly now?: () => number;
}

// A `creating` record in the lowest free slot, or the one asked for: the
// slot and the insert share one transaction, and the write is reported once
// it commits.
export async function createImpInFreeSlot(
  db: ImpDatabase,
  imp: Omit<NewImp, 'slot' | 'ip'>,
  slots: FreeSlots,
): Promise<ImpRecord> {
  const created = await db.transaction().execute(async (trx) => {
    if (slots.slot === undefined) {
      const slot = await allocateSlot(trx, slots.count, (slots.now ?? Date.now)());

      return writeImpRow(trx, { ...imp, slot, ip: slots.findIp(slot) });
    }

    const holder = await trx
      .selectFrom('imps')
      .select('id')
      .where('slot', '=', slots.slot)
      .executeTakeFirst();

    if (holder !== undefined || slots.slot >= slots.count) {
      throw new SlotTakenError(slots.slot);
    }

    return writeImpRow(trx, { ...imp, slot: slots.slot, ip: slots.findIp(slots.slot) });
  });

  emitImpWrite(db, { kind: 'added', imp: created });

  return created;
}

export async function findImpByName(db: ImpDatabase, name: string): Promise<ImpRecord | undefined> {
  const row = await db.selectFrom('imps').selectAll().where('name', '=', name).executeTakeFirst();

  return row === undefined ? undefined : toImpRecord(row);
}

export async function findImpById(db: ImpDatabase, id: string): Promise<ImpRecord | undefined> {
  const row = await db.selectFrom('imps').selectAll().where('id', '=', id).executeTakeFirst();

  return row === undefined ? undefined : toImpRecord(row);
}

export async function listImps(db: ImpDatabase): Promise<ImpRecord[]> {
  const rows = await db.selectFrom('imps').selectAll().orderBy('name').execute();

  return rows.map((row) => toImpRecord(row));
}

// imps by state; a state no imp is in is absent
export async function countImpsByState(db: ImpDatabase): Promise<Map<ImpState, number>> {
  const rows = await db
    .selectFrom('imps')
    .select((eb) => ['state', eb.fn.countAll<number>().as('count')])
    .groupBy('state')
    .execute();

  return new Map(rows.map((row) => [row.state, row.count]));
}

// Fields the change leaves out keep their value; null clears one.
export async function updateImpState(
  db: ImpDatabase,
  id: string,
  change: Readonly<ImpStateChange>,
): Promise<ImpRecord> {
  const values: Updateable<DatabaseSchema['imps']> = { state: change.state };

  if (change.error !== undefined) {
    values.error = change.error;
  }

  if (change.pid !== undefined) {
    values.pid = change.pid;
  }

  if (change.sleptAt !== undefined) {
    values.slept_at = change.sleptAt === null ? null : change.sleptAt.getTime();
  }

  if (change.firecrackerVersion !== undefined) {
    values.firecracker_version = change.firecrackerVersion;
  }

  const row = await db
    .updateTable('imps')
    .set({ ...values, ...buildAwakeValues(change), ...buildBootCauseValues(change) })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  return emitChange(db, toImpRecord(row), change);
}

// Compare-and-set: applies the change only while the row still has
// `expected` state and pid; undefined when something else changed it first.
export async function updateImpStateIf(
  db: ImpDatabase,
  id: string,
  expected: Readonly<{ state: ImpState; pid: number | null }>,
  change: Readonly<ImpStateChange>,
): Promise<ImpRecord | undefined> {
  const values: Updateable<DatabaseSchema['imps']> = { state: change.state };

  if (change.error !== undefined) {
    values.error = change.error;
  }

  if (change.pid !== undefined) {
    values.pid = change.pid;
  }

  if (change.sleptAt !== undefined) {
    values.slept_at = change.sleptAt === null ? null : change.sleptAt.getTime();
  }

  const pidOperator = expected.pid === null ? 'is' : '=';

  const row = await db
    .updateTable('imps')
    .set({ ...values, ...buildAwakeValues(change), ...buildBootCauseValues(change) })
    .where('id', '=', id)
    .where('state', '=', expected.state)
    .where('pid', pidOperator, expected.pid)
    .returningAll()
    .executeTakeFirst();

  return row === undefined ? undefined : emitChange(db, toImpRecord(row), change);
}

// Awake time, in the same write as the state: a running imp's span opens
// once (a re-adopt keeps it), and any other state closes it, a liveness
// repair after a crash included, so the time still counts. A wake counts.
function buildAwakeValues(change: Readonly<ImpStateChange>) {
  const now = Date.now();

  if (change.state === 'running') {
    const isWake = change.reason === 'woke' || change.countsWake === true;

    return {
      awake_since: sql<number>`coalesce(awake_since, ${now})`,
      ...(isWake && { wake_count: sql<number>`wake_count + 1` }),
    };
  }

  const until = change.awakeUntil?.getTime() ?? now;

  // max() is null while no span is open; an end before the start adds nothing
  return {
    awake_ms: sql<number>`awake_ms + coalesce(max(0, ${until} - awake_since), 0)`,
    awake_since: null,
  };
}

function buildBootCauseValues(change: Readonly<ImpStateChange>) {
  return change.nextBootCause === undefined ? {} : { next_boot_cause: change.nextBootCause };
}

// what imps.update changes; the caller applies a new CPU limit or weight
// to a running VM
interface ImpSettings {
  readonly cpu: Readonly<CpuSettings>;
  readonly vcpus: number;
  readonly httpPort: number;
}

export async function updateImpSettings(
  db: ImpDatabase,
  id: string,
  settings: Readonly<ImpSettings>,
): Promise<ImpRecord> {
  const cpu = settings.cpu;

  const row = await db
    .updateTable('imps')
    .set({
      cpu_limit: cpu.limit,
      cpu_weight: cpu.weight,
      vcpus: settings.vcpus,
      http_port: settings.httpPort,
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  const imp = toImpRecord(row);

  emitImpWrite(db, { kind: 'changed', imp, reason: 'updated' });

  return imp;
}

// A move's commit on the target: the mark off and the tickets committed in
// one transaction, so no crash leaves one without the other
export async function updateImpCommitted(
  db: ImpDatabase,
  id: string,
  committedAt: number,
  isWarm = false,
): Promise<ImpRecord> {
  const row = await db.transaction().execute(async (trx) => {
    // a warm move's imp sleeps on the memory it brought, and its first wake
    // installs this host's broker CA
    const updated = await trx
      .updateTable('imps')
      .set({
        move_state: null,
        ...(isWarm && { state: 'sleeping', slept_at: committedAt, trust_pending: 1 }),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .updateTable('move_tickets')
      .set({ committed_at: committedAt })
      .where('imp_id', '=', id)
      .execute();

    return updated;
  });

  const imp = toImpRecord(row);

  emitImpWrite(db, { kind: 'changed', imp, reason: 'updated' });

  return imp;
}

// true once, for an imp whose CA install a warm move left to its first wake
export async function claimTrustPending(db: ImpDatabase, id: string): Promise<boolean> {
  const taken = await db
    .updateTable('imps')
    .set({ trust_pending: 0 })
    .where('id', '=', id)
    .where('trust_pending', '=', 1)
    .returning('id')
    .executeTakeFirst();

  return taken !== undefined;
}

// sets or clears the move mark (moves/); the change goes out as `updated`
export async function updateImpMove(
  db: ImpDatabase,
  id: string,
  moveState: MoveState | null,
): Promise<ImpRecord> {
  const row = await db
    .updateTable('imps')
    .set({ move_state: moveState })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  const imp = toImpRecord(row);

  emitImpWrite(db, { kind: 'changed', imp, reason: 'updated' });

  return imp;
}

export async function updateImpActivity(db: ImpDatabase, id: string, at: Date): Promise<void> {
  await db.updateTable('imps').set({ last_active_at: at.getTime() }).where('id', '=', id).execute();
}

// the disk's size, and whether a sleeping guest still has to grow into it
export async function updateImpDisk(
  db: ImpDatabase,
  id: string,
  disk: Readonly<{ diskBytes: number; isGrowPending: boolean }>,
): Promise<ImpRecord> {
  const before = await findImpById(db, id);

  const row = await db
    .updateTable('imps')
    .set({ disk_bytes: disk.diskBytes, disk_grow_pending: disk.isGrowPending ? 1 : 0 })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  const sized = toImpRecord(row);

  // the API shows the size, not a grow the guest owes
  if (before?.diskBytes !== sized.diskBytes) {
    emitImpWrite(db, { kind: 'changed', imp: sized, reason: 'resized' });
  }

  return sized;
}

// A lease with no end counts as one that ends at the last time a Date holds.
const NO_END_MS = 8_640_000_000_000_000;

// hold_until becomes the latest end of the imp's leases (db/leases.ts), so
// the governor, the idle loop and the sleep checks read one field; run it
// in the lease write's transaction
export async function updateImpHold(db: ImpDatabase, id: string): Promise<ImpRecord> {
  const row = await db
    .updateTable('imps')
    .set((eb) => ({
      hold_until: eb
        .selectFrom('imp_leases')
        .select((inner) => inner.fn.max(inner.fn.coalesce('until', sql.lit(NO_END_MS))).as('end'))
        .where('imp_id', '=', id),
    }))
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  return toImpRecord(row);
}

// A public imp's auth as stored: the hash of the token or password, never
// the credential itself
export interface StoredPublicAuth {
  readonly auth: PublicAuth;
  readonly user: string | null;
  readonly hash: string | null;
}

// public with this auth, or tailnet-only for null; undefined, and no change,
// for an imp a move marked (docs/guides/hosts.md#moves)
export async function updateImpExposure(
  db: ImpDatabase,
  id: string,
  exposure: StoredPublicAuth | null,
): Promise<ImpRecord | undefined> {
  const row = await db
    .updateTable('imps')
    .set({
      exposure: exposure === null ? 'tailnet' : 'public',
      public_auth: exposure?.auth ?? null,
      public_user: exposure?.user ?? null,
      public_hash: exposure?.hash ?? null,
    })
    .where('id', '=', id)
    .where('move_state', 'is', null)
    .returningAll()
    .executeTakeFirst();

  if (row === undefined) {
    return undefined;
  }

  const changed = toImpRecord(row);

  emitImpWrite(db, { kind: 'changed', imp: changed, reason: 'exposed' });

  return changed;
}

// cascades to the imp's checkpoints
export async function removeImp(db: ImpDatabase, id: string): Promise<boolean> {
  const row = await db.deleteFrom('imps').where('id', '=', id).returningAll().executeTakeFirst();

  if (row === undefined) {
    return false;
  }

  emitImpWrite(db, { kind: 'removed', imp: toImpRecord(row) });

  return true;
}

function emitChange(
  db: ImpDatabase,
  imp: Readonly<ImpRecord>,
  change: Readonly<ImpStateChange>,
): ImpRecord {
  emitImpWrite(db, {
    kind: 'changed',
    imp,
    reason: change.reason,
    ...(change.detail !== undefined && { detail: change.detail }),
  });

  return imp;
}

// after the first cold boot of an imp from a template
export async function removeIdentityReset(db: ImpDatabase, id: string): Promise<ImpRecord> {
  const row = await db
    .updateTable('imps')
    .set({ identity_reset_pending: 0 })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  return toImpRecord(row);
}

function toImpRecord(row: Readonly<ImpRow>): ImpRecord {
  return {
    id: row.id,
    name: row.name,
    imageId: row.image_id,
    state: row.state,
    vcpus: row.vcpus,
    memoryMib: row.memory_mib,
    slot: row.slot,
    ip: row.ip,
    createdAt: new Date(row.created_at),
    lastActiveAt: new Date(row.last_active_at),
    sleptAt: toDate(row.slept_at),
    holdUntil: toDate(row.hold_until),
    error: row.error,
    pid: row.pid,
    firecrackerVersion: row.firecracker_version,
    httpPort: row.http_port,
    diskBytes: row.disk_bytes,
    isDiskGrowPending: row.disk_grow_pending === 1,
    cpu: { limit: row.cpu_limit, weight: row.cpu_weight },
    wakeCount: row.wake_count,
    awakeMs: row.awake_ms,
    awakeSince: toDate(row.awake_since),
    isIdentityResetPending: row.identity_reset_pending === 1,
    isTrustPending: row.trust_pending === 1,
    publicAuth: readPublicAuth(row),
    moveState: row.move_state,
    jailUid: row.jail_uid,
  };
}

// a value impd did not write reads as tailnet-only: closed, never open
function readPublicAuth(row: Readonly<ImpRow>): PublicAuth | null {
  const auth = PublicAuthSchema.safeParse(row.public_auth);

  return row.exposure === 'public' && auth.success ? auth.data : null;
}

function toDate(ms: number | null): Date | null {
  return ms === null ? null : new Date(ms);
}

export async function countImpsUsingImage(db: ImpDatabase, imageId: string): Promise<number> {
  const row = await db
    .selectFrom('imps')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('image_id', '=', imageId)
    .executeTakeFirstOrThrow();

  return row.count;
}
