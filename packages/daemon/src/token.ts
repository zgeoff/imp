import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The control API's bearer token (DESIGN 2.10): made on first start and kept
// in `<dataDir>/token`, readable by the owner only.
export function loadOrCreateToken(dataDir: string): string {
  const path = join(dataDir, 'token');

  if (existsSync(path)) {
    return readFileSync(path, 'utf8').trim();
  }

  const token = randomBytes(32).toString('base64url');

  writeFileSync(path, `${token}\n`, { mode: 0o600, flag: 'wx' });

  return token;
}

export function isAuthorized(header: string | null, token: string): boolean {
  if (header === null || !header.startsWith('Bearer ')) {
    return false;
  }

  const given = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);

  return given.length === expected.length && timingSafeEqual(given, expected);
}
