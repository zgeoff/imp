import { isImpAllowed } from '@imp/api';
import type { ApiActor, Identity, Scope } from '@imp/api';
import type { GrantableSecret } from '../db/tokens';
import { hasScope } from './scopes';

// Who a request runs as (docs/guides/tokens.md): a token, the dashboard
// session made with one, an ssh key, a tailnet identity, or an OAuth grant
export interface Caller {
  readonly kind: ApiActor;

  // the token's name, the key's comment or the tailnet login
  readonly name: string;
  readonly scope: Scope;

  // the imps it may touch; null for every imp and the host itself
  readonly imps: readonly string[] | null;

  // its token's list when this caller was built, read again by each grant
  // (docs/guides/tokens.md#change-the-list); none for a caller that is not
  // a token. Non-empty marks a token able to grant.
  readonly grantable: readonly GrantableSecret[];

  // the token behind it, so deleting the token ends what it opened; null
  // for an ssh key or a tailnet identity
  readonly tokenId: string | null;

  // the OAuth grant it acts for on the public MCP route, so revoking the
  // grant ends what it opened; null for every other caller
  readonly grantId: string | null;

  // when what it authenticated with expires: a dashboard session's expiry,
  // else null
  readonly expiresAt: number | null;

  // who owns the leases it takes (docs/guides/leases.md#owners); a token
  // through the API, a dashboard session and a key bound to it are one.
  // Null for a caller impd cannot name for good, which holds no lease.
  readonly principal: string | null;

  // the principal as a person reads it: the token's name, the key's comment
  // or the node's name
  readonly display: string;
}

// who an audit row names
export type AuditActor = Pick<Caller, 'kind' | 'name'>;

export function isCallerAllowed(caller: Readonly<Caller>, scope: Scope, name: string): boolean {
  return hasScope(caller.scope, scope) && isImpAllowed(caller.imps, name);
}

export function toIdentity(caller: Readonly<Caller>): Identity {
  return {
    kind: caller.kind,
    name: caller.name,
    scope: caller.scope,
    imps: caller.imps,
    grantable: caller.grantable.map((secret) => secret.name),
  };
}

export function formatCaller(caller: Readonly<Caller>): string {
  return `${caller.kind} ${caller.name}`;
}
