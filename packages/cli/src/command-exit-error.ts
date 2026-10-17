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
