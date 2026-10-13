import { ScopeSchema } from '../schemas/token-schema';
import type { Scope } from '../schemas/token-schema';

// Scopes nest: manage includes exec, and exec includes read. impd checks every
// call with it, and the MCP server lists only the tools a token's scope holds.
export function hasScope(granted: Scope, needed: Scope): boolean {
  return SCOPE_RANK[granted] >= SCOPE_RANK[needed];
}

// ScopeSchema lists the scopes in nesting order, so a scope's rank is its index
const SCOPE_RANK = Object.fromEntries(
  ScopeSchema.options.map((scope, rank) => [scope, rank]),
) as Readonly<Record<Scope, number>>;
