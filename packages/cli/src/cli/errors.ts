// A mistake in how the command was called, not a failure of the call: the
// CLI exits 2 for it, as for an unknown flag.
export class UsageError extends Error {
  override name = 'UsageError';
}

// The command ends the CLI with this code and prints nothing for it, as
// `impz exec` does with the code of the command it ran.
export class CommandExitError extends Error {
  override name = 'CommandExitError';

  readonly code: number;

  // the command left handles open, such as a terminal in raw mode, so the
  // process exits at once instead of when they close
  readonly mustExit: boolean;

  constructor(code: number, mustExit = false) {
    super(`exit ${String(code)}`);

    this.code = code;
    this.mustExit = mustExit;
  }
}

// gunshi refused the command line, such as for an unknown flag or a missing
// argument; `command` is the path of the command it was for
export class CommandLineError extends Error {
  override name = 'CommandLineError';

  readonly command: string;

  readonly refusal: AggregateError;

  constructor(command: string, refusal: AggregateError) {
    super(refusal.message, { cause: refusal });

    this.command = command;
    this.refusal = refusal;
  }
}
