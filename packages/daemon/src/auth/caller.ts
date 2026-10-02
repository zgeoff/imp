import type { ApiActor, Identity, Scope } from '@imp/api';
import { isImpAllowed } from './imp-patterns';
import { hasScope } from './scopes';

// Who a request runs as (docs/guides/tokens.md): a token, the dashboard
// session made with one, an ssh key or a tailnet identity
export interface Caller {
  readonly kind: ApiActor;

  // the token's name, the key's comment or the tailnet login
  readonly name: string;
  readonly scope: Scope;

  // the imps it may touch; null for every imp and the host itself
  readonly imps: readonly string[] | null;

  // the token behind it, so deleting the token ends what it opened; null
  // for an ssh key or a tailnet identity
  readonly tokenId: string | null;

  // when what it authenticated with expires: a dashboard session's expiry,
  // else null
  readonly expiresAt: number | null;
}

// who an audit row names
export type AuditActor = Pick<Caller, 'kind' | 'name'>;

export function isCallerAllowed(caller: Readonly<Caller>, scope: Scope, name: string): boolean {
  return hasScope(caller.scope, scope) && isImpAllowed(caller.imps, name);
}

export function toIdentity(caller: Readonly<Caller>): Identity {
  return { kind: caller.kind, name: caller.name, scope: caller.scope, imps: caller.imps };
}

export function formatCaller(caller: Readonly<Caller>): string {
  return `${caller.kind} ${caller.name}`;
}
