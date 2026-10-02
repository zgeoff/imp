import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { utils } from 'ssh2';

// The gateway's files live in <dataDir>/ssh, owner-only.
export function setupSshDir(dataDir: string): string {
  const dir = join(dataDir, 'ssh');

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  return dir;
}

// ed25519, made on first start, owner-only. The data directory outlives the
// container, so clients see the same key after every restart and upgrade.
// OpenSSH format: ssh2 does not read a PKCS8 ed25519 key.
export function loadOrCreateHostKey(sshDir: string): string {
  const path = join(sshDir, 'host_key');

  if (existsSync(path)) {
    return readFileSync(path, 'utf8');
  }

  const pair = createEd25519Key();

  writeFileSync(path, pair.private, { mode: 0o600, flag: 'wx' });

  return pair.private;
}

// ssh2's generator drops a leading zero byte of the public key (1 key in
// 256), and that key does not parse; such a key is made again
const MAX_KEY_ATTEMPTS = 16;

// an ed25519 key pair in OpenSSH format that ssh2 can read back
export function createEd25519Key(): { readonly private: string; readonly public: string } {
  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt += 1) {
    const pair = utils.generateKeyPairSync('ed25519');

    if (!(utils.parseKey(pair.private) instanceof Error)) {
      return pair;
    }
  }

  throw new Error(`no readable ed25519 key in ${String(MAX_KEY_ATTEMPTS)} attempts`);
}

// `SHA256:...`, as `ssh-keygen -l` and the ssh client print it
export function readFingerprint(privateKey: string): string {
  const parsed = utils.parseKey(privateKey);

  if (parsed instanceof Error) {
    throw parsed;
  }

  const digest = createHash('sha256').update(parsed.getPublicSSH()).digest('base64');

  return `SHA256:${digest.replace(/=+$/, '')}`;
}
