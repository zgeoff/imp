// Imp patterns limit a token to some imps: an imp name with `*` for any run
// of characters (ImpPatternSchema). Null patterns allow every imp.

export function isImpAllowed(patterns: readonly string[] | null, name: string): boolean {
  return patterns === null || patterns.some((pattern) => isPatternMatch(pattern, name));
}

// ImpPatternSchema allows no `%` or `_`, so a pattern becomes a LIKE
// pattern by its `*` alone
export function toLikePattern(pattern: string): string {
  return pattern.replaceAll('*', '%');
}

function isPatternMatch(pattern: string, name: string): boolean {
  const [first = '', ...rest] = pattern.split('*');

  if (rest.length === 0) {
    return name === first;
  }

  const last = rest.pop() ?? '';

  if (!name.startsWith(first) || !name.endsWith(last) || name.length < first.length + last.length) {
    return false;
  }

  // each middle part in order, between the prefix and the suffix
  let at = first.length;
  const end = name.length - last.length;

  for (const part of rest) {
    const found = name.indexOf(part, at);

    if (found === -1 || found + part.length > end) {
      return false;
    }

    at = found + part.length;
  }

  return true;
}
