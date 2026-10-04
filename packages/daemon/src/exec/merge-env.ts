// `KEY=VALUE` entries, `over` winning key by key; each key once, in the
// order it first appears
export function mergeEnv(base: readonly string[], over: readonly string[]): string[] {
  const merged = new Map<string, string>();

  for (const entry of [...base, ...over]) {
    merged.set(readEnvKey(entry), entry);
  }

  return [...merged.values()];
}

export function readEnvKey(entry: string): string {
  const at = entry.indexOf('=');

  return at === -1 ? entry : entry.slice(0, at);
}
