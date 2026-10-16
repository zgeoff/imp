import type { ImpState } from '@impz/api';
import { buildInvalidStateError } from '../api-errors';

// who may take an edge: every action, or only the one it names
type TransitionVia = 'any' | 'warm move';

// The imp lifecycle (docs/architecture/lifecycle/lifecycle.md#states).
// Destroy removes the record from any state, so it is no transition.
// stopped → sleeping is a warm move's commit, which no sleep may take.
const TRANSITIONS: Readonly<Record<ImpState, Readonly<Partial<Record<ImpState, TransitionVia>>>>> =
  {
    creating: { running: 'any', stopped: 'any', error: 'any' },
    running: { stopped: 'any', sleeping: 'any', error: 'any' },
    stopped: { running: 'any', sleeping: 'warm move', error: 'any' },
    sleeping: { running: 'any', stopped: 'any', error: 'any' },
    error: { running: 'any', stopped: 'any' },
  };

const STATES: readonly ImpState[] = ['creating', 'running', 'sleeping', 'stopped', 'error'];

export function canTransition(from: ImpState, to: ImpState, via: TransitionVia = 'any'): boolean {
  const edge = TRANSITIONS[from][to];

  return edge === 'any' || (edge !== undefined && edge === via);
}

// the states `to` is reachable from, for an INVALID_STATE answer
export function findStatesLeadingTo(to: ImpState, via: TransitionVia = 'any'): ImpState[] {
  return STATES.filter((from) => canTransition(from, to, via));
}

export function requireTransition(
  from: ImpState,
  to: ImpState,
  action: string,
  via: TransitionVia = 'any',
): void {
  if (!canTransition(from, to, via)) {
    throw buildInvalidStateError(from, findStatesLeadingTo(to, via), action);
  }
}
