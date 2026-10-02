import { PublicAuthSchema } from '@imp/api';
import type { PublicAuth } from '@imp/api';
import { UsageError } from './usage-error';

export interface PublicAuthRequest {
  readonly auth: PublicAuth;
  readonly user?: string;
}

// `--auth none|token|basic` and `--user u`: token by default, a user alone
// means basic, and only basic takes one
export function parsePublicAuth(
  auth: string | undefined,
  user: string | undefined,
): PublicAuthRequest {
  const parsed = PublicAuthSchema.safeParse(auth ?? (user === undefined ? 'token' : 'basic'));

  if (!parsed.success) {
    throw new UsageError(`--auth is none, token or basic, not ${auth ?? ''}`);
  }

  if (parsed.data !== 'basic' && user !== undefined) {
    throw new UsageError(`--user is for basic auth, not ${parsed.data}`);
  }

  return { auth: parsed.data, ...(user !== undefined && { user }) };
}
