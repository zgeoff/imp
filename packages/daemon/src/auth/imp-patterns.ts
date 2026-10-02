// Imp patterns as SQL: the matcher itself, isImpAllowed, is in @imp/api.

// ImpPatternSchema allows no `%` or `_`, so a pattern becomes a LIKE
// pattern by its `*` alone
export function toLikePattern(pattern: string): string {
  return pattern.replaceAll('*', '%');
}
