import { join } from 'node:path';
import { REPO_ROOT, runCommand } from './instance';

// The Tailscale auth key as scripts/dev.sh finds it (read_tailscale_authkey in
// scripts/lib.sh: the env, then 1Password, then .env), or null. It stays in
// this process: never print it.
export async function readTailscaleAuthKey(): Promise<string | null> {
  const result = await runCommand([
    'bash',
    '-c',
    'source "$1" && read_tailscale_authkey',
    'bash',
    join(REPO_ROOT, 'scripts', 'lib.sh'),
  ]);

  const key = result.stdout.trim();

  return result.exitCode === 0 && key !== '' ? key : null;
}
