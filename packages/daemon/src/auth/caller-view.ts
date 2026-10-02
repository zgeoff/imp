import type { Lease, LeaseSummary } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { buildForbiddenError, readCallerData } from '../api-errors';
import type { LeaseRecord } from '../db/leases';
import { formatCaller, isCallerAllowed } from './caller';
import type { Caller } from './caller';
import { hasScope } from './scopes';

// What a caller may see of other callers' leases and of the imps a refusal
// names (docs/guides/leases.md#owners). A null caller is an event's reader,
// who sees counts only.

// a caller with host-wide manage sees every owner; any other its own
function canSeeEveryOwner(caller: Readonly<Caller>): boolean {
  return caller.imps === null && hasScope(caller.scope, 'manage');
}

// who the caller's leases belong to; FORBIDDEN for a caller impd cannot
// name for good, such as a tagged node whose whois has no stable ID
export function requireLeaseHolder(caller: Readonly<Caller>): {
  readonly principal: string;
  readonly display: string;
} {
  if (caller.principal === null) {
    throw buildForbiddenError(
      `${formatCaller(caller)} has no stable identity, so it cannot hold a lease; use a token`,
    );
  }

  return { principal: caller.principal, display: caller.display };
}

export function toApiLease(name: string, lease: Readonly<LeaseRecord>): Lease {
  return {
    name,
    owner: { principal: lease.principal, display: lease.display, label: lease.label },
    until: lease.until,
  };
}

export function toLeaseSummary(
  caller: Readonly<Caller> | null,
  name: string,
  leases: readonly LeaseRecord[],
): LeaseSummary {
  const visible = leases.filter((lease) => isLeaseVisible(caller, lease));

  return {
    leases: visible.map((lease) => toApiLease(name, lease)),
    otherCount: leases.length - visible.length,
  };
}

export function isLeaseVisible(caller: Readonly<Caller> | null, lease: Readonly<LeaseRecord>) {
  return caller !== null && (canSeeEveryOwner(caller) || lease.principal === caller.principal);
}

// The error as the caller may see it: LEASED with the caller's own leases,
// RAM_BUDGET_EXCEEDED with the imps it may read. Any other error is as it was.
export function toCallerError(error: unknown, caller: Readonly<Caller> | null): unknown {
  const hidden = readCallerData(error);

  if (hidden === undefined || !(error instanceof ORPCError)) {
    return error;
  }

  const data: unknown = error.data;
  const base = typeof data === 'object' && data !== null ? data : {};

  const shown =
    hidden.kind === 'leases'
      ? toLeaseSummary(caller, hidden.name, hidden.leases)
      : readVisibleProtected(caller, hidden.imps);

  return new ORPCError(error.code, {
    status: error.status,
    message: error.message,
    data: { ...base, ...shown },
    cause: error.cause,
  });
}

function readVisibleProtected(
  caller: Readonly<Caller> | null,
  imps: readonly { readonly name: string }[],
) {
  const visible =
    caller === null ? [] : imps.filter((imp) => isCallerAllowed(caller, 'read', imp.name));

  return { protected: visible, protectedHidden: imps.length - visible.length };
}
