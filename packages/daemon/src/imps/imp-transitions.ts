import type { ImpState } from '@imp/api';
import { buildInvalidStateError } from '../api-errors';

// The imp lifecycle. Destroy is allowed from every state and removes the
// record, so it is not a transition. running ↔ sleeping arrives with sleep
// and wake.
const TRANSITIONS: Readonly<Record<ImpState, readonly ImpState[]>> = {
  creating: ['running', 'error'],
  running: ['stopped', 'sleeping', 'error'],
  stopped: ['running', 'error'],
  sleeping: ['running', 'stopped', 'error'],
  error: ['running', 'stopped'],
};

const STATES: readonly ImpState[] = ['creating', 'running', 'sleeping', 'stopped', 'error'];

export function canTransition(from: ImpState, to: ImpState): boolean {
  return TRANSITIONS[from].includes(to);
}

// the states `to` is reachable from, for an INVALID_STATE answer
export function findStatesLeadingTo(to: ImpState): ImpState[] {
  return STATES.filter((from) => canTransition(from, to));
}

export function requireTransition(from: ImpState, to: ImpState, action: string): void {
  if (!canTransition(from, to)) {
    throw buildInvalidStateError(from, findStatesLeadingTo(to), action);
  }
}
