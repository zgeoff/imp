import * as z from 'zod';

// Where an imp is in a move between hosts; docs/guides/hosts.md#moves says
// what each mark means. Nothing wakes or changes a marked imp.
export const MoveStateSchema = z.enum(['sending', 'moved', 'receiving']);

export type MoveState = z.infer<typeof MoveStateSchema>;

// the receiving host's base URL for the move routes: a literal tailnet
// address, so no name lookup can send the bytes elsewhere
export const PeerUrlSchema = z.url({ protocol: /^https?$/ });

// What a host must share with the source of a warm move
// (docs/architecture/moves.md#warm-moves): what loads a memory snapshot,
// and what the snapshot holds of the host
export const WarmHostSchema = z.object({
  firecrackerVersion: z.string(),
  snapshotVersion: z.string(),
  hostKernel: z.string(),
  cpuModel: z.string(),
  cpuFlags: z.string(),
  dataDir: z.string(),
  storage: z.enum(['xfs', 'zfs']),
  subnet: z.string(),
  slotCount: z.int().positive(),
  brokerPort: z.int().positive(),
  dns: z.array(z.string()).readonly(),
});

export type WarmHost = z.infer<typeof WarmHostSchema>;

// A sleeping imp's side of a warm move: its slot, its egress mode, what its
// snapshot was taken on, and the host it sleeps on. The target checks it
// against its own WarmHost.
export const WarmMoveSchema = z.object({
  slot: z.int().nonnegative(),
  egressMode: z.string(),
  snapshot: z.object({
    firecrackerVersion: z.string(),
    snapshotVersion: z.string(),
    hostKernel: z.string(),

    // null: a snapshot from an impd before the CPU was recorded
    cpuModel: z.string().nullable(),
    cpuFlags: z.string().nullable(),
    ipv6Prefix: z.string().nullable(),
  }),
  host: WarmHostSchema.pick({
    dataDir: true,
    storage: true,
    subnet: true,
    brokerPort: true,
    dns: true,
  }),
});

export type WarmMove = z.infer<typeof WarmMoveSchema>;

// What `moves.prepare` found to send: the bytes of data in the disk and
// its checkpoints, holes left out; a warm move's side, or null for cold
export const MovePlanSchema = z.object({
  bytes: z.int().nonnegative(),
  checkpoints: z.int().nonnegative(),
  warm: WarmMoveSchema.nullable(),
});

export type MovePlan = z.infer<typeof MovePlanSchema>;

// A receive ticket: single use for the stream, which must start before
// `expiresAt`, then good for the commit until `commitUntil`
export const MoveTicketSchema = z.object({
  ticket: z.string(),
  expiresAt: z.date(),
  peerUrl: PeerUrlSchema,
});

export type MoveTicket = z.infer<typeof MoveTicketSchema>;

// the source's side of a move as it runs in the background
export const MoveStatusSchema = z.object({
  state: MoveStateSchema.nullable(),
  peer: z.string().nullable(),
  sentBytes: z.int().nonnegative(),
  totalBytes: z.int().nonnegative(),

  // done: the target committed and the source's copy is gone
  isDone: z.boolean(),
  error: z.string().nullable(),
});

export type MoveStatus = z.infer<typeof MoveStatusSchema>;
