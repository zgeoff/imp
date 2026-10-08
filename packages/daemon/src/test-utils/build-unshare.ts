interface BuildUnshareOptions {
  // a mount namespace too, with private propagation
  readonly mount: boolean;

  // the uid the namespace is made by
  readonly uid: number | undefined;
}

// `unshare` with its flags for a fresh network namespace, and a mount one
// with `mount`. Root needs no user namespace, and one would hide what an
// unmapped uid owns, such as a CI runner's checkout under its home.
export function buildUnshare(options: BuildUnshareOptions): string[] {
  const user = options.uid === 0 ? '' : 'r';
  const flags = `-${user}n${options.mount ? 'm' : ''}`;

  return options.mount ? ['unshare', flags, '--propagation', 'private'] : ['unshare', flags];
}
