import * as z from 'zod';
import { NameSchema } from './name-schema';

// What a caller names its lease by; the pair (owner, label) is the lease
// (docs/guides/leases.md). `imps.hold` writes the label `hold`.
export const LeaseLabelSchema = z
  .string()
  .regex(/^[\w.:-]{1,64}$/, 'must be 1–64 letters, digits, dots, underscores, colons or hyphens');

// how long a lease lasts from now, in seconds
export const LeaseTtlSchema = z.int().min(10).max(3600);

// `principal` is who impd took the caller for: `token:<id>`, `key:<fingerprint>`,
// `tailnet:<node id>`, `tailnet-user:<login>`, `root`, or `legacy` for a hold
// from before leases. `display` names it for a person.
export const LeaseOwnerSchema = z.object({
  principal: z.string(),
  display: z.string(),
  label: z.string(),
});

export const LeaseSchema = z.object({
  name: NameSchema,
  owner: LeaseOwnerSchema,

  // null holds with no end
  until: z.date().nullable(),
});

// The leases a caller may see, and how many others there are: a caller
// with host-wide manage sees them all, any other its own. An event shows
// only the count.
export const LeaseSummarySchema = z.object({
  leases: z.array(LeaseSchema).readonly(),
  otherCount: z.int().nonnegative(),
});

export type Lease = z.infer<typeof LeaseSchema>;

export type LeaseSummary = z.infer<typeof LeaseSummarySchema>;
