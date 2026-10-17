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
