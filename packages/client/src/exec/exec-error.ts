import { EXEC_CLOSE_RESTARTING } from '@imp/api';
import type { ExecOutcome } from './open-exec-session';

// impd's codes come through as they are (NOT_FOUND, RAM_BUDGET_EXCEEDED,
// FORBIDDEN, EXEC_FAILED, …); the rest name what went wrong on the way
export type ExecClientErrorCode =
  | 'UNAUTHORIZED'
  | 'UNREACHABLE'
  | 'RESTARTING'
  | 'CONNECTION_CLOSED'
  | 'BAD_MESSAGE'
  | 'CLOSED'
  | 'OUTPUT_OVERFLOW'
  | 'LOCAL_ERROR';

// An exec that did not run to its exit. `data` is the error's data from
// impd, as over RPC: the budget numbers of RAM_BUDGET_EXCEEDED, for one.
export class ExecError extends Error {
  readonly code: string;

  readonly data: unknown;

  constructor(
    code: string,
    message: string,
    options: Readonly<{ data?: unknown; cause?: unknown }> = {},
  ) {
    const errorOptions = options.cause === undefined ? {} : { cause: options.cause };

    super(message, errorOptions);

    this.name = 'ExecError';
    this.code = code;
    this.data = options.data;
  }
}

export function toExecError(outcome: Exclude<ExecOutcome, { kind: 'exit' }>): ExecError {
  if (outcome.kind === 'failed') {
    return new ExecError(outcome.code ?? 'EXEC_ERROR', outcome.message, { data: outcome.data });
  }

  if (outcome.kind === 'unauthorized') {
    const message =
      outcome.ticketRefused === true
        ? 'impd refused the exec ticket: it expired (30 s) or was used already'
        : 'impd rejected the token';

    return new ExecError('UNAUTHORIZED', message);
  }

  if (outcome.kind === 'unreachable') {
    return new ExecError('UNREACHABLE', `cannot reach impd (${outcome.detail})`);
  }

  if (outcome.kind === 'closed') {
    return outcome.closeCode === EXEC_CLOSE_RESTARTING
      ? new ExecError('RESTARTING', 'impd is restarting')
      : new ExecError('CONNECTION_CLOSED', `exec connection closed (${outcome.reason})`);
  }

  if (outcome.kind === 'bad_message') {
    return new ExecError('BAD_MESSAGE', `bad message from impd: ${outcome.detail}`);
  }

  return new ExecError('LOCAL_ERROR', 'an output handler threw', { cause: outcome.error });
}
