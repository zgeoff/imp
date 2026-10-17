import { createHash } from 'node:crypto';

// the SHA-256 of a token, base64url: the only form of an access or refresh
// token the database holds
export function deriveTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
