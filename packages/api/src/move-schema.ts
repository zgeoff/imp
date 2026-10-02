import * as z from 'zod';

// Where an imp is in a move between hosts; docs/guides/hosts.md#moves says
// what each mark means. Nothing wakes or changes a marked imp.
export const MoveStateSchema = z.enum(['sending', 'moved', 'receiving']);

export type MoveState = z.infer<typeof MoveStateSchema>;

// the receiving host's base URL for the move routes: a literal tailnet
// address, so no name lookup can send the bytes elsewhere
export const PeerUrlSchema = z.url({ protocol: /^https?$/ });

// What `moves.prepare` found to send: the bytes of data in the disk and
// its checkpoints, holes left out
export const MovePlanSchema = z.object({
  bytes: z.int().nonnegative(),
  checkpoints: z.int().nonnegative(),
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
