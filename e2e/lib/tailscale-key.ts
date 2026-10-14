import { LIB_SCRIPT, runCommand } from './instance';

// The e2e suites' Tailscale key and tags as load_tailscale_e2e_authkey in
// scripts/lib.sh finds them, or null; never print the key. Only the tag:imp-e2e
// OAuth client: dev's tag:imp key would join a node that reaches a live impd.
export async function readTailscaleE2EAuthKey(): Promise<{ key: string; tags: string } | null> {
  const result = await runCommand([
    'bash',
    '-c',
    String.raw`source "$1"; load_tailscale_e2e_authkey || exit 0; printf "%s\n%s" "$IMP_TAILSCALE_TAGS" "$TAILSCALE_AUTHKEY"`,
    'bash',
    LIB_SCRIPT,
  ]);

  const [tags = '', ...rest] = result.stdout.split('\n');
  const key = rest.join('\n').trim();

  return key === '' ? null : { key, tags };
}

// whether main.ts gave this run the e2e key; the tailnet suites skip without it
export function hasTailscaleE2EKey(): boolean {
  return (
    (process.env['TAILSCALE_AUTHKEY'] ?? '') !== '' &&
    process.env['IMP_TAILSCALE_TAGS'] === 'tag:imp-e2e'
  );
}
