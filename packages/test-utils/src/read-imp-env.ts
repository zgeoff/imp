// A test's impd settings: the IMP_* variables it set with updateEnv, since the
// preload removed the shell's. DOCKER_HOST, TAILSCALE_AUTHKEY and the rest of
// the shell stay out of the config.
export function readImpEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[0].startsWith('IMP_') && entry[1] !== undefined,
    ),
  );
}
