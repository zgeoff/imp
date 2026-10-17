import { ScopeSchema } from '../schemas/token-schema';
import type { Scope } from '../schemas/token-schema';

// Scopes nest: manage includes exec, and exec includes read. ScopeSchema lists
// them in that order, so a scope's rank is its index. impd checks every call
// with it, and the MCP server lists only the tools a token's scope holds.
export function hasScope(granted: Scope, needed: Scope): boolean {
  const grantedRank = ScopeSchema.options.indexOf(granted);
  const neededRank = ScopeSchema.options.indexOf(needed);

  // a scope outside the list, which only an unchecked input carries, fails closed
  return grantedRank !== -1 && neededRank !== -1 && grantedRank >= neededRank;
}
