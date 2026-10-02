// `unshare` with its flags for a fresh network namespace, and a mount one
// with `mount`. Root needs no user namespace, and one would hide what an
// unmapped uid owns, such as a CI runner's checkout under its home.
export function buildUnshare(mount = false): string[] {
  const user = process.getuid?.() === 0 ? '' : 'r';
  const flags = `-${user}n${mount ? 'm' : ''}`;

  return mount ? ['unshare', flags, '--propagation', 'private'] : ['unshare', flags];
}
