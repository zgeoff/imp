import { ScopeSchema } from '../schemas/token-schema';
import type { Scope } from '../schemas/token-schema';

// Scopes nest: manage includes exec, and exec includes read. ScopeSchema lists
// them in that order, so a scope's rank is its index. impd checks every call
// with it, and the MCP server lists only the tools a token's scope holds.
export function hasScope(granted: Scope, needed: Scope): boolean {
  return ScopeSchema.options.indexOf(granted) >= ScopeSchema.options.indexOf(needed);
}
