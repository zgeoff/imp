import * as z from 'zod';
import { NameSchema } from './name-schema';

// The same form as an imp name, so a secret name is never a path or a flag
// (impd keeps each value in a file by that name).
export const SecretNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,30}$/,
    'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  );

// Printable ASCII without spaces: every API token is, and a value with CR or
// LF could split the header impd sets from it.
export const SecretValueSchema = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[!-~]+$/, 'must be printable ASCII without spaces');

// A hostname as a CONNECT names it: lowercase, no port, no wildcard. The last
// label starts with a letter, so an IP address is never one.
export const BrokerHostSchema = z
  .string()
  .max(253)
  .regex(
    /^(?:[a-z0-9][a-z0-9-]{0,62}\.)+[a-z][a-z0-9-]{0,62}$/,
    'must be a lowercase hostname such as api.example.com',
  );

// The header impd sets for the host, and how it renders the value:
// `bearer` is `Bearer <value>`, `basic` is HTTP Basic with `user` as the
// user name, and `raw` is the value as it is.
export const BrokerRuleSchema = z.object({
  host: BrokerHostSchema,
  header: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/, 'must be a lowercase header name such as authorization'),
  scheme: z.enum(['bearer', 'basic', 'raw']),
  user: z
    .string()
    .regex(/^[!-9;-~]{1,64}$/, 'must be printable ASCII without a colon')
    .optional(),
});

export type BrokerRule = z.infer<typeof BrokerRuleSchema>;

// A preset fills the rules and the guest's placeholder variables; `custom`
// takes its rules from the caller.
export const SecretKindSchema = z.enum(['github', 'anthropic', 'npm', 'custom']);

export type SecretKind = z.infer<typeof SecretKindSchema>;

// What the API shows of a secret. The value never leaves impd.
export const SecretSchema = z.object({
  name: SecretNameSchema,
  kind: SecretKindSchema,
  rules: z.array(BrokerRuleSchema).readonly(),

  // the imps it is granted to
  imps: z.array(NameSchema).readonly(),
  createdAt: z.date(),
});

export type Secret = z.infer<typeof SecretSchema>;

// One request the broker sent upstream with a credential. The path has no
// query string, and no header is kept.
export const AuditEntrySchema = z.object({
  at: z.date(),
  imp: NameSchema,
  secret: SecretNameSchema,
  method: z.string(),
  host: BrokerHostSchema,
  path: z.string(),

  // 502 when the upstream could not be reached
  status: z.int(),
  requestBytes: z.int().nonnegative(),
  responseBytes: z.int().nonnegative(),
  durationMs: z.int().nonnegative(),
});

export type AuditEntry = z.infer<typeof AuditEntrySchema>;
