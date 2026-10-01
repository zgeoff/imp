import type { ImpState } from '@imp/api';
import { ORPCError } from '@orpc/server';

type ResourceKind = 'imp' | 'image' | 'checkpoint';

// Errors from the contract's IMP_ERRORS, built where the services detect
// them; oRPC passes them to the client unchanged.

export function buildNotFoundError(kind: ResourceKind, name: string) {
  return new ORPCError('NOT_FOUND', {
    message: `${kind} ${name} not found`,
    data: { kind, name },
  });
}

export function buildConflictError(kind: ResourceKind, name: string, message?: string) {
  return new ORPCError('CONFLICT', {
    message: message ?? `${kind} ${name} already exists`,
    data: { kind, name },
  });
}

export function buildInvalidStateError(
  state: ImpState,
  allowed: readonly ImpState[],
  action: string,
) {
  return new ORPCError('INVALID_STATE', {
    status: 409,
    message: `cannot ${action} an imp that is ${state} (allowed: ${allowed.join(', ')})`,
    data: { state, allowed: [...allowed] },
  });
}
