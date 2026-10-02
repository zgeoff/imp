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

export function buildStoppingError() {
  return new ORPCError('SERVICE_UNAVAILABLE', { message: 'impd is stopping' });
}

export function isRamBudgetError(error: unknown): boolean {
  return error instanceof ORPCError && error.code === 'RAM_BUDGET_EXCEEDED';
}

// sleeping every other imp would not help: the guest can grow past the budget
export function buildImpOverBudgetError(budgetMib: number, usedMib: number, memoryMib: number) {
  return new ORPCError('RAM_BUDGET_EXCEEDED', {
    status: 503,
    message: `the imp's memory (${String(memoryMib)} MiB) is larger than the whole RAM budget (${String(budgetMib)} MiB)`,
    data: { budgetMib, usedMib, requestedMib: memoryMib },
  });
}

export function buildRamBudgetError(budgetMib: number, usedMib: number, requestedMib: number) {
  return new ORPCError('RAM_BUDGET_EXCEEDED', {
    status: 503,
    message: `not enough RAM: ${String(usedMib)} of ${String(budgetMib)} MiB in use, ${String(requestedMib)} MiB requested, and no idle imp left to sleep`,
    data: { budgetMib, usedMib, requestedMib },
  });
}
