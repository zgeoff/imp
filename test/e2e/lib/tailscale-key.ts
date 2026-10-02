import { join } from 'node:path';
import { REPO_ROOT, runCommand } from './instance';

export const LIB_SCRIPT = join(REPO_ROOT, 'scripts', 'lib.sh');

// The Tailscale auth key as dev.sh finds it (load_tailscale_authkey in
// scripts/lib.sh), or null; never print it. An op miss stays in this
// process's env, so later reads and the scripts this run starts skip op.
export async function readTailscaleAuthKey(): Promise<string | null> {
  const result = await runCommand([
    'bash',
    '-c',
    String.raw`source "$1"; load_tailscale_authkey; printf "%s\n%s" "$IMP_TAILSCALE_OP_MISSED" "$TAILSCALE_AUTHKEY"`,
    'bash',
    LIB_SCRIPT,
  ]);

  const [missed = '', ...rest] = result.stdout.split('\n');
  const key = rest.join('\n').trim();

  if (missed !== '') {
    process.env['IMP_TAILSCALE_OP_MISSED'] = missed;
  }

  return key === '' ? null : key;
}
