import * as z from 'zod';
import { ApiActorSchema } from './api-call-schema';
import { NameSchema } from './name-schema';

// What a token may do. Scopes nest: manage includes exec, exec includes read.
export const ScopeSchema = z.enum(['read', 'exec', 'manage']);

export type Scope = z.infer<typeof ScopeSchema>;

// An imp name with `*` for any run of characters, such as `dev-*`
export const ImpPatternSchema = z
  .string()
  .regex(
    /^[a-z*][a-z0-9*-]{0,30}$/,
    'must be an imp name, with * for any run of characters, such as dev-*',
  );

// What the API shows of a token. The secret is shown once, by tokens.create.
export const TokenSchema = z.object({
  name: NameSchema,
  scope: ScopeSchema,

  // the imps it may touch; null for every imp and the host itself
  imps: z.array(ImpPatternSchema).readonly().nullable(),
  createdAt: z.date(),
});

export type Token = z.infer<typeof TokenSchema>;

// Who a call runs as: the token, the dashboard session made with one, an ssh
// key, or a tailnet identity
export const IdentitySchema = z.object({
  kind: ApiActorSchema,
  name: z.string(),
  scope: ScopeSchema,
  imps: z.array(ImpPatternSchema).readonly().nullable(),
});

export type Identity = z.infer<typeof IdentitySchema>;
