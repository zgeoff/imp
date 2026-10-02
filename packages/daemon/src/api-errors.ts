import type { ImpState } from '@imp/api';
import { ORPCError } from '@orpc/server';
import type { LeaseRecord } from './db/leases';

type ResourceKind =
  | 'imp'
  | 'image'
  | 'checkpoint'
  | 'session'
  | 'service'
  | 'secret'
  | 'grant'
  | 'backup'
  | 'token'
  | 'ssh-key'
  | 'network';

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

// the caller's scope or imp patterns do not cover the call
export function buildForbiddenError(message: string) {
  return new ORPCError('FORBIDDEN', { message });
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

export function buildAgentOutdatedApiError(message: string) {
  return new ORPCError('AGENT_OUTDATED', { status: 409, message });
}

// how long a caller waits before it asks again about a moving imp
export const MOVING_RETRY_AFTER_S = 30;

// a move holds no lock while it sends: every other change fails at once
export function buildMovingError(name: string) {
  return new ORPCError('MOVING', {
    status: 409,
    message: `${name} is moving between hosts; try again in ${String(MOVING_RETRY_AFTER_S)} s`,
    data: { retryAfterS: MOVING_RETRY_AFTER_S },
  });
}

export function buildStoppingError() {
  return new ORPCError('SERVICE_UNAVAILABLE', { message: 'impd is stopping' });
}

export function isRamBudgetError(error: unknown): boolean {
  return error instanceof ORPCError && error.code === 'RAM_BUDGET_EXCEEDED';
}

// an awake imp the governor could not sleep to make room
export interface ProtectedImp {
  readonly name: string;
  readonly ramMib: number;

  // a live lease of any kind, `hold` included
  readonly leased: boolean;

  // under a lifecycle operation, in use, or its sleep failed
  readonly busy: boolean;
}

// What only some callers may see: lease owners, other imps' names. The
// error carries counts; auth/caller-view.ts adds what each caller may see.
type CallerData =
  | { readonly kind: 'leases'; readonly name: string; readonly leases: readonly LeaseRecord[] }
  | { readonly kind: 'protected'; readonly imps: readonly ProtectedImp[] };

const callerData = new WeakMap<object, CallerData>();

export function readCallerData(error: unknown): CallerData | undefined {
  return typeof error === 'object' && error !== null ? callerData.get(error) : undefined;
}

interface RamShortfall {
  readonly budgetMib: number;
  readonly usedMib: number;
  readonly requestedMib: number;
  readonly protected: readonly ProtectedImp[];
}

// sleeping every other imp would not help: the guest can grow past the budget
export function buildImpOverBudgetError(budgetMib: number, usedMib: number, memoryMib: number) {
  return buildRamError(
    `the imp's memory (${String(memoryMib)} MiB) is larger than the whole RAM budget (${String(budgetMib)} MiB)`,
    { budgetMib, usedMib, requestedMib: memoryMib, protected: [] },
  );
}

export function buildRamBudgetError(shortfall: Readonly<RamShortfall>) {
  const used = String(shortfall.usedMib);
  const budget = String(shortfall.budgetMib);
  const requested = String(shortfall.requestedMib);

  return buildRamError(
    `not enough RAM: ${used} of ${budget} MiB in use, ${requested} MiB requested, and no idle imp left to sleep`,
    shortfall,
  );
}

// what a boot or wake lacks past the budget; GovernorDecision says it too
export function readNeededMib(usedMib: number, requestedMib: number, budgetMib: number): number {
  return Math.max(0, usedMib + requestedMib - budgetMib);
}

function buildRamError(message: string, shortfall: Readonly<RamShortfall>) {
  const error = new ORPCError('RAM_BUDGET_EXCEEDED', {
    status: 503,
    message,
    data: {
      budgetMib: shortfall.budgetMib,
      usedMib: shortfall.usedMib,
      requestedMib: shortfall.requestedMib,
      neededMib: readNeededMib(shortfall.usedMib, shortfall.requestedMib, shortfall.budgetMib),
      protected: [],
      protectedHidden: shortfall.protected.length,
    },
  });

  callerData.set(error, { kind: 'protected', imps: shortfall.protected });

  return error;
}

// a user's sleep or stop, without force, of an imp leased through leases.*
export function buildLeasedError(name: string, leases: readonly LeaseRecord[]) {
  const error = new ORPCError('LEASED', {
    status: 409,
    message: `imp ${name} has ${String(leases.length)} lease(s); force ends them`,
    data: { leases: [], otherCount: leases.length },
  });

  callerData.set(error, { kind: 'leases', name, leases });

  return error;
}

export function buildLeaseNotHeldError(name: string, label: string) {
  return new ORPCError('LEASE_NOT_HELD', {
    status: 409,
    message: `the caller holds no live lease ${label} on imp ${name}`,
  });
}

export function isDiskFullError(error: unknown): error is ORPCError<'DISK_FULL', unknown> {
  return error instanceof ORPCError && error.code === 'DISK_FULL';
}
