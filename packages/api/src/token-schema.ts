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

// the most SSH keys one token holds
export const MAX_SSH_KEYS = 16;

// An SSH public key line, as in a `.pub` file: `<type> <base64> [comment]`
export const SshPublicKeySchema = z.string().trim().min(1).max(16_384);

// What the API shows of a key bound to a token; never the key itself
export const SshKeySchema = z.object({
  // `SHA256:<base64>`, as `ssh-keygen -l` prints it
  fingerprint: z.string(),
  type: z.string(),
  comment: z.string(),
});

export type SshKey = z.infer<typeof SshKeySchema>;

// What the API shows of a token. The secret is shown once, by tokens.create.
export const TokenSchema = z.object({
  name: NameSchema,
  scope: ScopeSchema,

  // the imps it may touch; null for every imp and the host itself
  imps: z.array(ImpPatternSchema).readonly().nullable(),

  // the SSH keys that log in as it (docs/guides/ssh.md#keys-bound-to-tokens)
  sshKeys: z.array(SshKeySchema).readonly(),
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
