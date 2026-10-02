import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The ID that marks a service as this host's: made on first use and kept in
// the data dir, so it outlives the tailnet node, which a re-registered
// ephemeral key replaces.
export function loadOrCreateHostId(dataDir: string): string {
  const dir = join(dataDir, 'tailnet-names');
  const path = join(dir, 'host-id');

  if (existsSync(path)) {
    return readFileSync(path, 'utf8').trim();
  }

  mkdirSync(dir, { recursive: true });

  const id = randomBytes(16).toString('hex');

  writeFileSync(path, `${id}\n`, { mode: 0o600, flag: 'wx' });

  return id;
}
