import { GrantPatternSchema } from '@imp/api';
import type { Scope } from '@imp/api';
import { hasScope } from '../auth/scopes';

// A grant never outgrows the token that approved it
// (docs/guides/mcp.md#public-route); its narrow pattern grammar makes
// "within" exact.

export function isGrantPattern(pattern: string): boolean {
  return GrantPatternSchema.safeParse(pattern).success;
}

export function isPatternsWithin(
  grant: readonly string[] | null,
  token: readonly string[] | null,
): boolean {
  if (token === null) {
    return true;
  }

  if (grant === null) {
    return false;
  }

  return grant.every((pattern) => token.some((own) => isPatternWithin(pattern, own)));
}

function isPatternWithin(pattern: string, own: string): boolean {
  if (pattern === own) {
    return true;
  }

  // a token pattern with `*` only at its end covers every name or prefix
  // that starts with what comes before it
  const star = own.indexOf('*');

  return star === own.length - 1 && pattern.startsWith(own.slice(0, -1));
}

export function readLowerScope(a: Scope, b: Scope): Scope {
  return hasScope(a, b) ? b : a;
}

// the scopes a granted one holds, as an OAuth `scope` lists them
export function formatScopeList(scope: Scope): string {
  const nested: Record<Scope, string> = {
    read: 'read',
    exec: 'read exec',
    manage: 'read exec manage',
  };

  return nested[scope];
}
