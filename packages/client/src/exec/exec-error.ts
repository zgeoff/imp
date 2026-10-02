// impd's codes come through as they are (NOT_FOUND, RAM_BUDGET_EXCEEDED,
// FORBIDDEN, EXEC_FAILED, …); the rest name what went wrong on the way
export type ExecClientErrorCode =
  | 'UNAUTHORIZED'
  | 'UNREACHABLE'
  | 'RESTARTING'
  | 'CONNECTION_CLOSED'
  | 'DETACHED'
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
