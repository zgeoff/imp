import type { Scope } from '@imp/api';

// Scopes nest: manage includes exec, and exec includes read
const RANK: Readonly<Record<Scope, number>> = { read: 0, exec: 1, manage: 2 };

export function hasScope(granted: Scope, needed: Scope): boolean {
  return RANK[granted] >= RANK[needed];
}
